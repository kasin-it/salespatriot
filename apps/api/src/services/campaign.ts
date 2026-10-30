import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { errorMessage, now, sleep } from "../lib/util.ts";
import { enqueueTask, type TaskContext } from "../agents/orchestrator.ts";
import { demandForCategory } from "./demand.ts";
import { logAgentEmail } from "./emaillog.ts";
import { mailboxReady, readAgentEmail, sendAgentEmail, withBlock } from "./mailneg.ts";
import { addStep, getDemoConfig, parseRequest, planStands, profileFor, rankEvents, setMission, specificTokens, type StandCandidate } from "./mission.ts";
import { loadProfile, publicKnowledge, runPreEventConversation, type Ctx } from "./preevent.ts";
import { think } from "./think.ts";

/**
 * A campaign is one event, three phases.
 *  BEFORE: agents write to several exhibitors, gather context and decide whether the event is worth the trip and who to approach.
 *  WHILE : after the human approves the shortlist, agents brief the salesperson per stand, read the material, negotiate.
 *  AFTER : follow-ups go out, a summary is produced, the deal is on record.
 * Humans approve the shortlist and the follow-ups; everything else is observable.
 */

export interface PublicFacts {
  name: string; country: string | null; website: string | null; stand: string | null; categories: string[]; description: string | null;
  capabilities: { label: string; cls: string; evidence: string; source: string | null }[]; certifications: string[]; awards: { evidence: string; url: string | null }[];
}

export function publicFacts(companyId: number, eventId: number): PublicFacts {
  const db = getDb();
  const c = db.get<{ canonical_name: string; country: string | null; website: string | null }>("SELECT canonical_name, country, website FROM companies WHERE id=?", companyId)!;
  const x = db.get<{ booth: string | null; description: string | null; categories: string | null }>("SELECT booth, description, categories FROM event_exhibitors WHERE event_id=? AND company_id=? LIMIT 1", eventId, companyId);
  const caps = db.all<{ label: string; capability_class: string; evidence_text: string; source_url: string | null; source_type: string }>("SELECT label, capability_class, evidence_text, source_url, source_type FROM company_capabilities WHERE company_id=? ORDER BY capability_class", companyId);
  return {
    name: c.canonical_name, country: c.country, website: c.website, stand: x?.booth ?? null, categories: json<string[]>(x?.categories ?? null, []), description: x?.description ?? null,
    capabilities: caps.filter((k) => k.source_type !== "PROCUREMENT_PORTAL").map((k) => ({ label: k.label, cls: k.capability_class, evidence: k.evidence_text, source: k.source_url })),
    certifications: db.all<{ name: string }>("SELECT DISTINCT name FROM company_certifications WHERE company_id=?", companyId).map((r) => r.name),
    awards: caps.filter((k) => k.source_type === "PROCUREMENT_PORTAL").map((k) => ({ evidence: k.evidence_text, url: k.source_url })),
  };
}

export interface Scored { score: number; why: string[]; unknown: string[] }
/** Transparent scoring from stored evidence only. Every point has a reason that is shown to the human. */
export function scoreSupplier(c: StandCandidate, f: PublicFacts, hasProfile: boolean): Scored {
  let score = 0; const why: string[] = []; const unknown: string[] = [];
  if (c.specificHits?.length) { score += 30; why.push(`its own listing mentions “${c.specificHits.join(", ")}”`); }
  else if (c.hits.length) { score += 12; why.push(`its listing matches the category (“${c.hits.slice(0, 2).join(", ")}”)`); }
  if (f.awards.length) { score += 20; why.push(`named as awardee in ${f.awards.length} public tender notice(s) in this category`); }
  if (f.certifications.length) { score += Math.min(20, f.certifications.length * 10); why.push(`mentions ${f.certifications.slice(0, 2).join(", ")} on its own site`); } else unknown.push("certifications");
  if (f.website) { score += 10; why.push("has an official website to verify against"); } else unknown.push("official website");
  if (f.stand) { score += 10; why.push(`stand known (${f.stand})`); } else unknown.push("stand location");
  if ((f.description?.length ?? 0) > 80 || f.categories.length > 1) { score += 10; why.push("publishes a product/category description"); }
  if (hasProfile) { score += 20; why.push("its agent answered with attendees, exhibits and meeting slots"); }
  unknown.push("who attends", "what they will show", "price and lead time");
  return { score: Math.min(100, score), why, unknown };
}

const BANNER_PUBLIC = (n: string) => `[Public-record agent for ${n} — answers ONLY from what is published. ${n} has not authorised this agent and has not been contacted.]`;

export function publicRecordReply(f: PublicFacts, ctx: Ctx): { text: string; data: Record<string, unknown> } {
  const lines = [BANNER_PUBLIC(f.name), "", `Hello ${ctx.buyer.replace(/\.+$/, "")} team — what is published about ${f.name}:`, "",
    "1. Who is on site: not published.",
    `2. Stand: ${f.stand ? `listed at stand ${f.stand} in the official exhibitor list` : "not published"}.`,
    `3. What is shown: ${f.categories.length ? `exhibitor profile lists ${f.categories.slice(0, 4).join("; ")}` : f.description ? `profile says “${f.description.slice(0, 160)}”` : "not published"}.`,
    `4. Public information: ${[f.website ? `website ${f.website}` : null, f.capabilities.length ? `site text suggests ${f.capabilities.slice(0, 2).map((k) => k.label).join(", ")} (a claim, not verified)` : null, f.certifications.length ? `mentions ${f.certifications.slice(0, 3).join(", ")}` : null, f.awards.length ? `${f.awards.length} public award notice(s) name this company` : null].filter(Boolean).join("; ") || "nothing beyond the listing"}. Specifications, price, availability and lead time are not published — on site only.`,
    "5. Meeting slot: not published; approach the stand directly.", "", `Public-record agent for ${f.name}`];
  return { text: lines.join("\n"), data: { type: "PUBLIC_RECORD_ANSWERS", unknown: ["attendees", "specifications", "price and lead time", "availability"] } };
}

async function converse(missionId: number, tag: string, ctx: Ctx, f: PublicFacts): Promise<{ turns: number }> {
  const pace = Number(process.env.PREEVENT_PACE_MS ?? 1500);
  const useMail = mailboxReady();
  const sendAndRead = async (n: number, from: "buyer" | "supplier", subject: string, text: string, data: Record<string, unknown>) => {
    const body = withBlock(text, data);
    let emailed = false; let readBack = false;
    if (useMail) {
      try { await sendAgentEmail({ subject: `[PRE-${tag}-${n}] ${subject}`, from, text: body }); emailed = true; readBack = !!(await readAgentEmail(`[PRE-${tag}-${n}]`)); } catch (e) { void errorMessage(e); }
    }
    addStep(missionId, "mail", `${from === "buyer" ? "Buyer agent → Public-record agent" : "Public-record agent → Buyer agent"}: ${subject}`, "DONE", { n, from, subject: `[PRE-${tag}-${n}] ${subject}`, text: body, emailed, readBack, supplier: f.name });
    await sleep(pace);
  };
  const subject = `Meeting at ${ctx.event}? Looking for ${ctx.product}`;
  const need = `${ctx.quantity ? `${ctx.quantity} × ` : ""}${ctx.product}${ctx.deadline ? `, needed by ${ctx.deadline}` : ""}`;
  await sendAndRead(1, "buyer", subject, ["Hello,", "", `I am the procurement agent of ${ctx.buyer.replace(/\.+$/, "")}. We are looking for ${need}.`, `Ahead of ${ctx.event}${ctx.dates ? ` (${ctx.dates})` : ""} I would like to know: who will be on site, where your stand is, what you show, what is public and what is only available on site, and a meeting slot.`, "", `Buyer agent for ${ctx.buyer.replace(/\.+$/, "")}`].join("\n"), { type: "PRE_EVENT_QUESTIONS", questions: ["attendees", "stand", "showing", "shareable_now", "meeting_slot"] });
  const r = publicRecordReply(f, ctx);
  await sendAndRead(2, "supplier", `Re: ${subject}`, r.text, r.data);
  await sendAndRead(3, "buyer", `Re: ${subject}`, [`Thank you. I will treat ${f.name} as ${f.stand ? `a stand to visit (${f.stand})` : "a stand to look up"} and ask my colleague on site for: attendees, specification, price and lead time, availability.`, "", `Buyer agent for ${ctx.buyer.replace(/\.+$/, "")}`].join("\n"), { type: "PRE_EVENT_ACK", open: ["attendees", "specification", "price and lead time", "availability"] });
  return { turns: 3 };
}

export interface ShortlistItem { companyId: number; name: string; booth: string | null; score: number; why: string[]; unknown: string[]; mode: "OPERATOR_PROFILE" | "PUBLIC_RECORD"; evidence: string; tag: string }
export interface Report { verdict?: { call: "GO" | "MAYBE" | "NO_GO"; reasons: string[] }; shortlist?: ShortlistItem[]; eventId?: number; summary?: Record<string, unknown>; followupsSentAt?: string }

export async function investigate(ctx: TaskContext, missionId: number): Promise<{ status: string }> {
  const db = getDb();
  const m = db.get<{ company_id: number; user_id: number | null; prompt: string; event_id: number }>("SELECT * FROM missions WHERE id=?", missionId)!;
  const cfg = getDemoConfig();
  const fail = (t: string) => { addStep(missionId, "error", t, "ERROR"); setMission(missionId, { status: "FAILED", error: t }); return { status: "FAILED" }; };
  try {
    ctx.progress("Understanding the request");
    const parsed = await parseRequest(m.prompt);
    db.update("missions", missionId, { parsed: JSON.stringify(parsed) });
    addStep(missionId, "parse", `Understood: ${parsed.quantity ? `${parsed.quantity} × ` : ""}${parsed.product}${parsed.deadlineText ? `, ${/^by\b/i.test(parsed.deadlineText) ? "" : "by "}${parsed.deadlineText}` : ""} → category “${parsed.categoryLabel ?? "unknown"}”`, "DONE", { ...parsed });
    await think(missionId, "How I read your request", { request: m.prompt, quantity: parsed.quantity, deadline: parsed.deadline, product: parsed.product, category: parsed.categoryLabel },
      `I read this as ${parsed.quantity ?? "an unspecified number of"} × ${parsed.product}${parsed.deadline ? `, needed by ${parsed.deadline}` : ""}, category “${parsed.categoryLabel ?? "none"}”. Before anyone travels I want to know whether ${m.event_id ? "this event" : "an event"} is worth it.`);
    if (!parsed.categoryKey) return fail("I could not map this to a product category.");
    const specific = specificTokens(parsed.product);
    const ev = db.get<{ id: number; name: string; start_date: string | null; end_date: string | null }>("SELECT id, name, start_date, end_date FROM events WHERE id=?", m.event_id);
    if (!ev) return fail("Event not found.");
    const rank = rankEvents(parsed.categoryKey, parsed.deadline, specific).find((r) => r.eventId === ev.id);
    const demand = demandForCategory(parsed.categoryKey, { specific, limit: 4 });
    addStep(missionId, "demand", `Real demand: ${demand.totals.open} open tenders and ${demand.totals.awards} recent awards for “${parsed.categoryLabel}”`, "DONE", demand);
    addStep(missionId, "event_fit", `Event fit: ${ev.name} — ${rank?.matching ?? 0} matching exhibitors${rank?.fitsDeadline === true ? ", takes place before your deadline" : rank?.fitsDeadline === false ? ", does NOT fit your deadline" : ""}`, "DONE", { event: ev, rank });

    const cands = planStands(ev.id, parsed.categoryKey, specific, 4);
    if (!cands.length) return fail("No exhibitor at this event resolved to a company yet.");
    const dates = ev.start_date ? `${ev.start_date}${ev.end_date && ev.end_date !== ev.start_date ? ` – ${ev.end_date}` : ""}` : null;
    const buyer = db.get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", m.company_id)!.canonical_name;
    addStep(missionId, "candidates", `${cands.length} candidate exhibitors to investigate`, "DONE", { candidates: cands.map((c) => ({ name: c.name, booth: c.booth, evidence: c.evidence, hits: c.hits, specific: c.specificHits })) });
    const shortlist: ShortlistItem[] = [];
    for (let k = 0; k < cands.length; k++) {
      const c = cands[k]!;
      if (ctx.isCancelled()) break;
      ctx.progress(`Writing to ${c.name} (${k + 1}/${cands.length})`);
      const f = publicFacts(c.companyId!, ev.id);
      const profile = loadProfile(c.companyId!);
      const cx: Ctx = { buyer, supplier: f.name, event: ev.name, dates, product: parsed.product, quantity: parsed.quantity, deadline: parsed.deadline, startup: false, known: [], deliveryLocation: cfg.deliveryLocation };
      const tag = `${missionId}-${k + 1}`;
      addStep(missionId, "supplier", `Contacting ${f.name}${f.stand ? ` (stand ${f.stand})` : ""} — ${profile ? "its agent has operator-entered facts" : "public-record agent only"}`, "ACTIVE", { name: f.name });
      if (profile) await runPreEventConversation(missionId, { ...cx, known: publicKnowledge(c.companyId!).known.slice(0, 3) }, profile, { tag });
      else await converse(missionId, tag, cx, f);
      const sc = scoreSupplier(c, f, !!profile);
      shortlist.push({ companyId: c.companyId!, name: f.name, booth: f.stand, score: sc.score, why: sc.why, unknown: sc.unknown, mode: profile ? "OPERATOR_PROFILE" : "PUBLIC_RECORD", evidence: c.evidence, tag });
      db.run("UPDATE mission_steps SET status='DONE' WHERE mission_id=? AND kind='supplier' AND status='ACTIVE'", missionId);
      addStep(missionId, "supplier_context", `${f.name}: fit score ${sc.score}/100`, "DONE", { name: f.name, booth: f.stand, score: sc.score, why: sc.why, unknown: sc.unknown, mode: profile ? "OPERATOR_PROFILE" : "PUBLIC_RECORD" });
    }
    shortlist.sort((a, b) => b.score - a.score);
    const strong = shortlist.filter((s) => s.score >= 50);
    const reasons: string[] = [];
    let call: "GO" | "MAYBE" | "NO_GO";
    if (rank?.fitsDeadline === false) { call = "NO_GO"; reasons.push(`The event does not fit your deadline (${parsed.deadline}).`); }
    else if (strong.length >= 2) { call = "GO"; reasons.push(`${strong.length} of ${shortlist.length} contacted exhibitors score 50+ on public evidence.`); }
    else if (shortlist.some((s) => s.score >= 35)) { call = "MAYBE"; reasons.push(`Only ${strong.length} strong candidate(s); the rest rest on thin public information.`); }
    else { call = "NO_GO"; reasons.push("No contacted exhibitor shows enough public evidence for this product."); }
    if (demand.totals.open > 0) reasons.push(`${demand.totals.open} open public tenders show real demand in this category.`);
    if (rank?.fitsDeadline === true) reasons.push("The event takes place before your deadline.");
    reasons.push(`Unknown until someone is on site: attendees, specifications, price, lead time.`);
    const report: Report = { verdict: { call, reasons }, shortlist, eventId: ev.id };
    db.update("missions", missionId, { report: JSON.stringify(report) });
    addStep(missionId, "verdict", `Verdict: ${call.replace("_", "-")} — ${call === "GO" ? "worth going" : call === "MAYBE" ? "worth a limited visit" : "not worth the trip"}`, "DONE", { call, reasons, shortlist });
    await think(missionId, "Is it worth going?", { event: ev.name, dates, verdict: call, eventFitsDeadline: rank?.fitsDeadline ?? null, openTenders: demand.totals.open, candidates: shortlist.map((s) => ({ name: s.name, score: s.score, stand: s.booth, why: s.why.slice(0, 2) })) },
      `My call is ${call.replace("_", "-")}. ${strong.length} of ${shortlist.length} exhibitors look strong on public evidence${shortlist[0] ? `, led by ${shortlist[0].name} (${shortlist[0].score}/100)` : ""}. Everything beyond the listings — specifications, price, who attends — is unknown until someone stands at the booth, so I would send people only to the shortlisted stands.`);
    setMission(missionId, { status: "INVESTIGATED" });
    audit({ actorType: "agent", actorId: "buyer_agent", companyId: m.company_id, action: "campaign.investigated", entityType: "mission", entityId: missionId, summary: `Pre-event investigation of ${ev.name}: ${call}; ${shortlist.length} suppliers contacted by email` });
    return { status: "INVESTIGATED" };
  } catch (e) {
    addStep(missionId, "error", errorMessage(e), "ERROR");
    setMission(missionId, { status: "FAILED", error: errorMessage(e) });
    throw e;
  }
}

/** Human approval: the selected shortlisted stands get a field mission each (the salesperson is briefed per stand). */
export function dispatchCampaign(userId: number, missionId: number, companyIds: number[]): number[] {
  const db = getDb();
  const m = db.get<{ company_id: number; event_id: number; status: string; parsed: string | null; report: string | null }>("SELECT * FROM missions WHERE id=?", missionId);
  if (!m || m.status !== "INVESTIGATED") throw new Error("The investigation has to finish first.");
  const rep = getDemoConfig().rep;
  if (!rep) throw new Error("No salesperson is configured (Setup).");
  const report = json<Report>(m.report, {}); const parsed = json<{ categoryKey?: string; quantity?: number | null }>(m.parsed, {});
  const picks = (report.shortlist ?? []).filter((s) => companyIds.includes(s.companyId));
  if (!picks.length) throw new Error("Select at least one stand.");
  const prof = profileFor(parsed.categoryKey ?? null);
  const ids: number[] = [];
  for (const s of picks) {
    const child = db.insert("missions", { company_id: m.company_id, user_id: userId, kind: "FIELD", prompt: `Visit ${s.name}`, status: "RUNNING", parent_id: missionId, event_id: m.event_id });
    addStep(child, "start", `Dispatched by the campaign after human approval: visit ${s.name}${s.booth ? ` (stand ${s.booth})` : ""}`, "DONE");
    const lines = ["Z rozmowy agentów przed eventem:", `• Wynik dopasowania: ${s.score}/100 — ${s.why.slice(0, 2).join("; ")}`, "", "Tego nie dało się ustalić przed eventem — dowiedz się na stoisku:", ...s.unknown.map((u) => `• ${u}`)];
    enqueueTask("buyer_agent", "mission.run", { missionId: child, field: { eventId: m.event_id, targetCompanyId: s.companyId, standHint: s.booth, quantity: parsed.quantity ?? null, profile: prof, extraLines: lines } }, `user:${userId}`, { companyId: m.company_id, priority: 1 });
    ids.push(child);
  }
  setMission(missionId, { status: "IN_EVENT" });
  addStep(missionId, "dispatch", `You approved ${picks.length} stand(s): ${picks.map((p) => p.name).join(", ")}. ${rep.name} is being briefed per stand.`, "DONE", { companies: picks.map((p) => p.name), person: rep.name });
  audit({ actorType: "user", actorId: userId, companyId: m.company_id, action: "campaign.dispatched", entityType: "mission", entityId: missionId, summary: `Human approved ${picks.length} stand(s) for ${rep.name}` });
  return ids;
}

export interface FollowupDraft { companyId: number; name: string; kind: "deal" | "quote_request" | "no_reply" | "thanks"; subject: string; body: string; tag: string }

export function followupDrafts(missionId: number): FollowupDraft[] {
  const db = getDb();
  const m = db.get<{ company_id: number; report: string | null }>("SELECT company_id, report FROM missions WHERE id=?", missionId);
  const report = json<Report>(m?.report ?? null, {});
  const buyer = db.get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", m!.company_id)!.canonical_name.replace(/\.+$/, "");
  return (report.shortlist ?? []).map((s, i) => {
    const child = db.get<{ id: number; status: string; field_request_id: number | null; deal_id: number | null }>("SELECT id, status, field_request_id, deal_id FROM missions WHERE parent_id=? AND target_company_id=?", missionId, s.companyId);
    const fr = child?.field_request_id ? db.get<{ status: string; summary: string | null }>("SELECT status, summary FROM field_requests WHERE id=?", child.field_request_id) : undefined;
    const deal = child?.deal_id ? db.get<{ deal_ref: string; total_value: number | null; currency: string | null; terms: string }>("SELECT deal_ref, total_value, currency, terms FROM deals WHERE id=?", child.deal_id) : undefined;
    const tag = `${missionId}-${i + 1}`;
    const gaps = json<{ gaps?: string[] }>(fr?.summary ?? null, {}).gaps ?? [];
    if (deal) return { companyId: s.companyId, name: s.name, kind: "deal" as const, tag, subject: `Next steps after agreement ${deal.deal_ref}`, body: `Hello,\n\nOur agents reached an agreement (${deal.deal_ref}${deal.total_value != null ? `, total ${Math.round(deal.total_value).toLocaleString()} ${deal.currency}` : ""}). This is a recorded acceptance, not a signed contract.\n\nNext steps from our side: purchase order draft, delivery schedule, required documents (certificates, export licence status).\nPlease confirm the contact person for order handling.\n\nBuyer agent for ${buyer}` };
    if (fr?.status === "REPLIED") return { companyId: s.companyId, name: s.name, kind: "quote_request" as const, tag, subject: `Thank you — missing details for ${s.name}`, body: `Hello,\n\nThank you for the material shared at the stand. To finish our evaluation please confirm: ${gaps.length ? gaps.join("; ") : "payment terms, delivery terms, offer validity"}.\n\nBuyer agent for ${buyer}` };
    if (child) return { companyId: s.companyId, name: s.name, kind: "no_reply" as const, tag, subject: `Following up from the event — ${s.name}`, body: `Hello,\n\nOur colleague was not able to complete the conversation at your stand. We are still interested and would welcome a short call or an email with your datasheet and indicative lead time.\n\nBuyer agent for ${buyer}` };
    return { companyId: s.companyId, name: s.name, kind: "thanks" as const, tag, subject: `Thank you — ${s.name}`, body: `Hello,\n\nThank you for the public information. We did not visit your stand this time but may come back for a later requirement.\n\nBuyer agent for ${buyer}` };
  });
}

export async function sendFollowups(userId: number, missionId: number): Promise<{ sent: number; summary: Record<string, unknown> }> {
  const db = getDb();
  const m = db.get<{ company_id: number; status: string; report: string | null }>("SELECT company_id, status, report FROM missions WHERE id=?", missionId);
  if (!m || !["IN_EVENT", "INVESTIGATED"].includes(m.status)) throw new Error("Follow-ups can be sent while the campaign is running or after the investigation.");
  const drafts = followupDrafts(missionId);
  let sent = 0;
  for (const d of drafts) {
    const subject = `[POST-${d.tag}] ${d.subject}`;
    try {
      if (mailboxReady()) await sendAgentEmail({ subject, from: "buyer", text: d.body });
      logAgentEmail({ kind: "followup", from: "buyer-agent@arsenal.test", to: "supplier-agent@arsenal.test", subject, body: d.body, missionId });
      addStep(missionId, "followup", `Follow-up to ${d.name}: ${d.subject}`, "DONE", { ...d, subject });
      sent++;
    } catch (e) { addStep(missionId, "followup", `Follow-up to ${d.name} failed: ${errorMessage(e)}`, "ERROR"); }
  }
  const children = db.all<{ status: string; deal_id: number | null }>("SELECT status, deal_id FROM missions WHERE parent_id=?", missionId);
  const dealRows = children.filter((c) => c.deal_id).map((c) => db.get<{ deal_ref: string; total_value: number | null; currency: string | null; negotiation_id: number }>("SELECT deal_ref, total_value, currency, negotiation_id FROM deals WHERE id=?", c.deal_id!)!);
  const humanApprovals = dealRows.reduce((a, d) => a + (db.get<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND decided_by_user_id IS NOT NULL", d.negotiation_id)?.n ?? 0), 0);
  const report = json<Report>(m.report, {});
  const summary = { suppliersContacted: report.shortlist?.length ?? 0, standsVisited: children.length, repliesReceived: children.filter((c) => c.status !== "RUNNING" && c.status !== "WAITING_REPLY").length, dealsClosed: dealRows.length, deals: dealRows.map((d) => ({ ref: d.deal_ref, value: d.total_value, currency: d.currency })), humanApprovals, followupsSent: sent, verdict: report.verdict?.call ?? null };
  report.summary = summary; report.followupsSentAt = now();
  db.update("missions", missionId, { report: JSON.stringify(report) });
  addStep(missionId, "summary", `Event summary: ${summary.dealsClosed} deal(s) closed with ${humanApprovals} human approvals, ${sent} follow-up(s) sent`, "DONE", summary);
  await think(missionId, "Event outcome", { ...summary, event: db.get<{ name: string }>("SELECT e.name FROM missions m JOIN events e ON e.id=m.event_id WHERE m.id=?", missionId)?.name }, `Outcome: ${summary.dealsClosed} deal(s) closed after contacting ${summary.suppliersContacted} suppliers and visiting ${summary.standsVisited} stands, with ${humanApprovals} human approvals. I sent ${sent} follow-ups so nobody who engaged is left waiting.`);
  setMission(missionId, { status: "COMPLETE" });
  audit({ actorType: "user", actorId: userId, companyId: m.company_id, action: "campaign.followups_sent", entityType: "mission", entityId: missionId, summary: `${sent} follow-up emails sent; ${summary.dealsClosed} deal(s)` });
  return { sent, summary };
}
