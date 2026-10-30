import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { errorMessage, now, sleep } from "../lib/util.ts";
import { CATEGORY_BY_KEY, classifyText } from "../lib/taxonomy.ts";
import { mailboxReady, readAgentEmail, sendAgentEmail, withBlock } from "./mailneg.ts";
import { addStep, getDemoConfig, parseRequest, profileFor, rankEvents, setMission, specificTokens } from "./mission.ts";
import { onboardCompany } from "./onboarding.ts";
import { think } from "./think.ts";
import { demandForCategory } from "./demand.ts";
import type { TaskContext } from "../agents/orchestrator.ts";

/**
 * Pre-event conversation. The BUYER agent writes to the SUPPLIER agent (real emails) to learn who will be at the event, where, what they bring,
 * and which information is only available on site. The supplier agent answers ONLY from the facts its operator entered (SANDBOX); anything not
 * covered is answered "not stated", and gated topics are answered "on site only". Nothing is invented and nothing is stored as a fact about the company.
 */

export interface SupplierProfile {
  company_id: number; event_id: number | null; own_company: number; focus: string; stand: string | null; days_present: string | null;
  attendees: { name: string; role: string }[]; bringing: string[]; shareable: string[]; gated: { topic: string; how: string }[]; meeting_slots: string[];
}

export function loadProfile(companyId: number): SupplierProfile | undefined {
  const r = getDb().get<Record<string, unknown>>("SELECT * FROM supplier_profiles WHERE company_id=?", companyId);
  if (!r) return undefined;
  return { company_id: companyId, event_id: r.event_id as number | null, own_company: r.own_company as number, focus: r.focus as string, stand: r.stand as string | null, days_present: r.days_present as string | null,
    attendees: json(r.attendees as string, []), bringing: json(r.bringing as string, []), shareable: json(r.shareable as string, []), gated: json(r.gated as string, []), meeting_slots: json(r.meeting_slots as string, []) };
}

export function saveProfile(companyId: number, p: Omit<SupplierProfile, "company_id">, userId: number): void {
  const db = getDb();
  db.run("DELETE FROM supplier_profiles WHERE company_id=?", companyId);
  db.insert("supplier_profiles", { company_id: companyId, event_id: p.event_id, own_company: p.own_company, focus: p.focus, attendees: JSON.stringify(p.attendees), stand: p.stand, days_present: p.days_present, bringing: JSON.stringify(p.bringing), shareable: JSON.stringify(p.shareable), gated: JSON.stringify(p.gated), meeting_slots: JSON.stringify(p.meeting_slots), created_by_user_id: userId });
  audit({ actorType: "user", actorId: userId, action: "supplier_profile.saved", entityType: "company", entityId: companyId, summary: `Pre-event supplier agent facts entered by the operator (${p.own_company ? "own company" : "SIMULATED, not from the company"})` });
}

/** What is publicly known about a company, from stored sources only, and what is not. */
export function publicKnowledge(companyId: number): { known: string[]; unknown: string[]; thin: boolean } {
  const db = getDb();
  const c = db.get<{ canonical_name: string; country: string | null; website: string | null; description: string | null }>("SELECT canonical_name, country, website, description FROM companies WHERE id=?", companyId);
  const caps = db.all<{ label: string }>("SELECT label FROM company_capabilities WHERE company_id=? AND capability_class != 'UNVERIFIED_CAPABILITY'", companyId);
  const prods = db.get<{ n: number }>("SELECT COUNT(*) n FROM company_products WHERE company_id=?", companyId)!.n;
  const certs = db.get<{ n: number }>("SELECT COUNT(*) n FROM company_certifications WHERE company_id=?", companyId)!.n;
  const known: string[] = [];
  const unknown: string[] = [];
  if (c?.country) known.push(`Country: ${c.country}`); else unknown.push("Country");
  if (c?.website) known.push(`Website: ${c.website}`); else unknown.push("Website");
  if (c?.description) known.push(`Self-description: ${c.description.slice(0, 140)}`); else unknown.push("What the company does");
  if (caps.length) known.push(`Claimed areas: ${caps.slice(0, 3).map((x) => x.label).join(", ")}`); else unknown.push("Product categories / capabilities");
  if (prods) known.push(`${prods} product headings on its site`); else unknown.push("Products and specifications");
  if (certs) known.push(`Certification mentions: ${certs}`); else unknown.push("Certifications");
  unknown.push("Who will attend the event", "What they will show", "Price and lead time");
  return { known, unknown, thin: known.length <= 3 };
}

/**
 * First-run convenience: when nobody has entered a supplier-agent profile, the operator's OWN demo company gets a starter profile
 * (clearly labelled in the UI as a demo supplier; editable under Missions → Scenario 3). Event and meeting slots come from real event data;
 * the people and what they bring are placeholders the operator can replace.
 */
export function ensureDemoSupplier(userId: number, product: string, categoryKey: string, deadline: string | null): { profile: SupplierProfile; created: boolean } | null {
  const db = getDb();
  const name = "Skyhawk Defence (demo startup)";
  let co = db.get<{ id: number }>("SELECT c.id FROM companies c JOIN company_memberships m ON m.company_id=c.id WHERE m.user_id=? AND c.canonical_name=?", userId, name);
  if (!co) co = { id: onboardCompany({ userId, legalName: name, country: "PL", authorizationLevel: "SIGNATORY", jobTitle: "Demo operator" }).companyId };
  const ranked = rankEvents(categoryKey, deadline, specificTokens(product)).filter((r) => r.startDate);
  const ev = ranked[0] ?? rankEvents(categoryKey, deadline)[0];
  if (!ev) return null;
  const day1 = ev.startDate!, day2 = ev.endDate && ev.endDate > ev.startDate! ? new Date(Date.parse(ev.startDate!) + 86400_000).toISOString().slice(0, 10) : ev.startDate!;
  saveProfile(co.id, { event_id: ev.eventId, own_company: 1, focus: product, stand: "stand assigned on arrival", days_present: `${day1}${day2 !== day1 ? ` – ${day2}` : ""}`,
    attendees: [{ name: "Anna Nowak", role: "CEO" }, { name: "Piotr Zieliński", role: "CTO" }], bringing: ["Working prototype (demo unit)", "Live demonstration screen"],
    shareable: [`Company focus: ${product}`, "Prototype tested in field trials (TRL 6)"],
    gated: [{ topic: "Technical specification", how: "under NDA, on site" }, { topic: "Pricing and lead time", how: "given on site only" }, { topic: "Export licence status", how: "discussed in person" }],
    meeting_slots: [`${day1}, 14:00`, `${day2}, 10:30`] }, userId);
  return { profile: loadProfile(co.id)!, created: true };
}

// ---- Message builders (pure; exported for tests) -------------------------------------------------------------
export interface Ctx { buyer: string; supplier: string; event: string; dates: string | null; product: string; quantity: number | null; deadline: string | null; startup: boolean; known: string[]; deliveryLocation: string | null }
export const QUESTIONS = ["attendees", "stand", "showing", "shareable_now", "meeting_slot"] as const;

export function buyerIntro(c: Ctx): { subject: string; text: string; data: Record<string, unknown> } {
  const need = `${c.quantity ? `${c.quantity} × ` : ""}${c.product}${c.deadline ? `, needed by ${c.deadline}` : ""}`;
  const text = [
    "Hello,", "",
    `I am the procurement agent of ${nm(c.buyer)}. We are looking for ${need}.${c.startup ? " We are specifically interested in early-stage / startup suppliers." : ""}`,
    `What I could find publicly about ${c.supplier}: ${c.known.length ? c.known.join("; ") : "only the company name"}. Product details are not public, so I would rather ask than assume.`, "",
    `Ahead of ${c.event}${c.dates ? ` (${c.dates})` : ""}, could you tell me:`,
    "1. Who from your team will be on site, and on which days?", "2. Where is your stand?", "3. What will you be showing or demonstrating?", "4. What can you share before the event, and what is only available on site?", "5. Which meeting slot suits you?", "",
    "Thank you,", `Buyer agent for ${nm(c.buyer)}`,
  ].join("\n");
  return { subject: `Meeting at ${c.event}? Looking for ${c.product}`, text, data: { type: "PRE_EVENT_QUESTIONS", questions: [...QUESTIONS], need: { product: c.product, quantity: c.quantity, deadline: c.deadline } } };
}

const BANNER_SIM = "[SANDBOX — simulated supplier agent; the facts below were entered by the operator, not published by the company]";
/** The operator's own company speaks for itself, so no banner. A real exhibitor's record is always flagged: its facts are the operator's, not the company's. */
const banner = (p: SupplierProfile): string => (p.own_company ? "" : BANNER_SIM);
const nm = (s: string): string => s.replace(/\.+$/, "");
export function supplierReply1(p: SupplierProfile, c: Ctx, questions: readonly string[]): { text: string; data: Record<string, unknown> } {
  const lines: string[] = [...(banner(p) ? [banner(p), ""] : []), `Hello ${nm(c.buyer)} team,`, "", `Thank you for reaching out about ${c.product}. Answers to your questions:`, ""];
  const ans = (q: string): string => {
    switch (q) {
      case "attendees": return p.attendees.length ? `On site: ${p.attendees.map((a) => `${a.name} (${a.role})`).join("; ")}${p.days_present ? `, ${p.days_present}` : ""}.` : "Not stated.";
      case "stand": return p.stand ? `Our stand: ${p.stand}.` : "Not stated yet.";
      case "showing": return p.bringing.length ? `We will bring: ${p.bringing.join("; ")}.` : "Not stated.";
      case "shareable_now": return `${p.shareable.length ? `Shareable before the event: ${p.shareable.join("; ")}.` : "Nothing is shareable before the event."} ${p.gated.length ? `On site only: ${p.gated.map((g) => `${g.topic} (${g.how})`).join("; ")}.` : ""}`.trim();
      case "meeting_slot": return p.meeting_slots.length ? `We can meet: ${p.meeting_slots.join(" or ")}.` : "Not stated.";
      default: return "Not stated.";
    }
  };
  const label: Record<string, string> = { attendees: "1. Who is on site", stand: "2. Stand", showing: "3. What we show", shareable_now: "4. Before the event vs. on site only", meeting_slot: "5. Meeting slots" };
  for (const q of questions) lines.push(`${label[q] ?? q}: ${ans(q)}`);
  lines.push("", "To prepare properly we need from you:", "a) quantity and delivery date,", "b) delivery location,", "c) required certifications or end-user constraints.", "", `Regards,`, `Supplier agent for ${c.supplier}`);
  return { text: lines.join("\n"), data: { type: "PRE_EVENT_ANSWERS", gated: p.gated.map((g) => g.topic), slots: p.meeting_slots, asks: ["quantity_delivery", "delivery_location", "requirements"] } };
}

export function buyerReply2(c: Ctx, asks: readonly string[], slots: readonly string[], gated: readonly string[]): { text: string; data: Record<string, unknown> } {
  const lines = ["Thank you, this helps.", ""];
  for (const a of asks) {
    if (a === "quantity_delivery") lines.push(`a) Quantity: ${c.quantity ?? "not fixed yet"}. Needed by: ${c.deadline ?? "not fixed yet"}.`);
    if (a === "delivery_location") lines.push(`b) Delivery location: ${c.deliveryLocation ?? "not stated yet"}.`);
    if (a === "requirements") lines.push("c) Certifications / end-user: not defined yet — I will confirm them at the meeting. I do not want to state requirements I cannot back up.");
  }
  const slot = slots[0];
  lines.push("", slot ? `Let's take the slot: ${slot}.` : "Please propose a slot.", "Please bring: a datasheet, the demo unit if possible, and your NDA template.", gated.length ? `At the meeting we would like to cover: ${gated.join("; ")}.` : "", "", `Buyer agent for ${nm(c.buyer)}`);
  return { text: lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n"), data: { type: "PRE_EVENT_SLOT_CHOICE", slot: slot ?? null, topics: gated } };
}

export function supplierReply2(p: SupplierProfile, c: Ctx, slot: string | null): { text: string; data: Record<string, unknown> } {
  const who = p.attendees[0];
  const text = [banner(p), slot ? `Confirmed: ${slot}${p.stand ? ` at ${p.stand}` : ""}${who ? ` with ${who.name} (${who.role})` : ""}.` : "We will confirm the slot shortly.",
    p.bringing.length ? `We will have: ${p.bringing.join("; ")}.` : "", "We will bring our NDA template; gated topics are covered after signing.", "Commercial terms are given on site, not by email.", "", `Supplier agent for ${c.supplier}`].filter(Boolean).join("\n");
  return { text, data: { type: "PRE_EVENT_CONFIRM", slot, attendee: who?.name ?? null } };
}

export function buyerConfirm(c: Ctx, slot: string | null, stand: string | null, gated: readonly string[]): { text: string; data: Record<string, unknown> } {
  return { text: [`Agreed${slot ? `: ${slot}` : ""}${stand ? `, ${stand}` : ""}.`, gated.length ? `Open items for the meeting: ${gated.join("; ")}.` : "", "A colleague will be on site.", "", `Buyer agent for ${nm(c.buyer)}`].filter(Boolean).join("\n"), data: { type: "PRE_EVENT_AGREED", slot, stand } };
}

// ---- Mission --------------------------------------------------------------------------------------------------
export interface Turn { n: number; from: "buyer" | "supplier"; subject: string; text: string; readBack: boolean; emailed: boolean }

export async function runPreEventConversation(missionId: number, ctx: Ctx, profile: SupplierProfile, opts: { tag?: string } = {}): Promise<Turn[]> {
  const pace = Number(process.env.PREEVENT_PACE_MS ?? 1500);
  const useMail = mailboxReady();
  const turns: Turn[] = [];
  const base = `[PRE-${opts.tag ?? missionId}-`;
  const post = async (n: number, from: "buyer" | "supplier", subject: string, text: string, data: Record<string, unknown>): Promise<Record<string, unknown> | null> => {
    const body = withBlock(text, data);
    let readBack = false; let emailed = false; let parsed: Record<string, unknown> | null = data;
    if (useMail) {
      try {
        await sendAgentEmail({ subject: `${base}${n}] ${subject}`, from, text: body }); emailed = true;
        const got = await readAgentEmail(`${base}${n}]`);
        if (got?.data) { readBack = true; parsed = got.data; }
      } catch (e) { void errorMessage(e); }
    }
    const turn: Turn = { n, from, subject: `${base}${n}] ${subject}`, text: body, readBack, emailed };
    turns.push(turn);
    addStep(missionId, "mail", `${from === "buyer" ? "Buyer agent → Supplier agent" : "Supplier agent → Buyer agent"}: ${subject}`, "DONE", { ...turn, supplier: ctx.supplier });
    if (n < 5) await sleep(pace);
    return parsed;
  };
  const q1 = buyerIntro(ctx);
  const d1 = await post(1, "buyer", q1.subject, q1.text, q1.data);
  const asked = Array.isArray(d1?.questions) ? (d1!.questions as string[]) : [...QUESTIONS];
  const r1 = supplierReply1(profile, ctx, asked);
  const d2 = await post(2, "supplier", `Re: ${q1.subject}`, r1.text, r1.data);
  const asks = Array.isArray(d2?.asks) ? (d2!.asks as string[]) : ["quantity_delivery"];
  const slots = Array.isArray(d2?.slots) ? (d2!.slots as string[]) : profile.meeting_slots;
  const gated = Array.isArray(d2?.gated) ? (d2!.gated as string[]) : profile.gated.map((g) => g.topic);
  const r2 = buyerReply2(ctx, asks, slots, gated);
  const d3 = await post(3, "buyer", `Re: ${q1.subject}`, r2.text, r2.data);
  const slot = typeof d3?.slot === "string" ? d3.slot : null;
  const r3 = supplierReply2(profile, ctx, slot);
  await post(4, "supplier", `Re: ${q1.subject}`, r3.text, r3.data);
  const r4 = buyerConfirm(ctx, slot, profile.stand, gated);
  await post(5, "buyer", `Re: ${q1.subject}`, r4.text, r4.data);
  return turns;
}

export async function runPreEventMission(ctx: TaskContext, missionId: number, opts: { supplierCompanyId?: number }): Promise<{ status: string }> {
  const db = getDb();
  const m = db.get<{ company_id: number; user_id: number | null; prompt: string }>("SELECT * FROM missions WHERE id=?", missionId)!;
  const cfg = getDemoConfig();
  const fail = (title: string): { status: string } => { addStep(missionId, "error", title, "ERROR"); setMission(missionId, { status: "FAILED", error: title }); return { status: "FAILED" }; };
  try {
    ctx.progress("Understanding the request");
    const parsed = await parseRequest(m.prompt);
    db.update("missions", missionId, { parsed: JSON.stringify(parsed) });
    const startup = /start-?up|early[- ]stage|scale-?up/i.test(m.prompt);
    addStep(missionId, "parse", `Understood: looking for ${startup ? "a startup building " : ""}${parsed.product}${parsed.categoryLabel ? ` → category “${parsed.categoryLabel}”` : ""}`, "DONE", { ...parsed });
    await think(missionId, "How I read your request", { request: m.prompt, product: parsed.product, category: parsed.categoryLabel, startupFocus: startup, quantity: parsed.quantity, deadline: parsed.deadline },
      `You want ${startup ? "a startup" : "a supplier"} working on ${parsed.product}${parsed.quantity ? ` (${parsed.quantity} units)` : ""}. I mapped that to “${parsed.categoryLabel ?? "no category"}”. A startup usually publishes little, so I expect some information to be gated.`);
    if (!parsed.categoryKey) return fail("I could not map this request to a product category. Name the technology (e.g. counter-drone interceptors).");
    const demand = demandForCategory(parsed.categoryKey, { specific: specificTokens(parsed.product), limit: 4 });
    addStep(missionId, "demand", `Real demand: ${demand.totals.open} open tenders for “${parsed.categoryLabel}”`, "DONE", demand);

    await think(missionId, "What the tenders tell me", { openTenders: demand.totals.open, recentAwards: demand.totals.awards, topOpen: demand.open.slice(0, 3).map((n) => ({ title: n.title, authority: n.authority, country: n.country })), caveat: "A tender shows public demand, not that anyone wants to trade with us" },
      `There are ${demand.totals.open} open tenders and ${demand.totals.awards} recent awards in this category, so the demand is real. That is context only: it does not mean any buyer wants to trade with us.`);

    // Candidate: explicit choice, or the best supplier-agent profile whose focus fits the requested category.
    let profile: SupplierProfile | undefined = opts.supplierCompanyId ? loadProfile(opts.supplierCompanyId) : undefined;
    if (!profile) {
      const all = db.all<{ company_id: number }>("SELECT company_id FROM supplier_profiles").map((r) => loadProfile(r.company_id)!).filter(Boolean);
      profile = all.find((p) => classifyText(`${p.focus} ${p.shareable.join(" ")}`).some((h) => h.key === parsed.categoryKey));
    }
    let demoSupplier = false;
    if (!profile && m.user_id) { const made = ensureDemoSupplier(m.user_id, parsed.product, parsed.categoryKey, parsed.deadline); if (made) { profile = made.profile; demoSupplier = true; } }
    if (!profile) return fail("No supplier agent is available and no researched event matches this technology yet.");
    const sup = db.get<{ canonical_name: string; country: string | null }>("SELECT canonical_name, country FROM companies WHERE id=?", profile.company_id)!;
    const ev = db.get<{ id: number; name: string; start_date: string | null; end_date: string | null }>("SELECT id, name, start_date, end_date FROM events WHERE id=?", profile.event_id ?? -1);
    if (!ev) return fail("The supplier profile has no event assigned.");
    const pk = publicKnowledge(profile.company_id);
    setMission(missionId, { event_id: ev.id, target_company_id: profile.company_id });
    addStep(missionId, "candidate", `Candidate: ${sup.canonical_name} — ${pk.thin ? "public information is THIN (gated); I will ask their agent" : "some public information available"}`, "DONE", { supplier: sup.canonical_name, own: !!profile.own_company, event: ev.name, known: pk.known, unknown: pk.unknown, simulated: !profile.own_company, demoSupplier });
    await think(missionId, "Why I'm asking their agent", { candidate: sup.canonical_name, event: ev.name, publiclyKnown: pk.known, notPublic: pk.unknown, publicInfoIsThin: pk.thin },
      `I know very little about ${sup.canonical_name} from public sources: ${pk.known.length ? pk.known.slice(0, 2).join("; ") : "only the name"}. Instead of guessing what they build or who will attend ${ev.name}, I will ask their agent directly and keep everything unanswered marked as unknown.`);
    const buyer = db.get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", m.company_id)!;
    const dates = ev.start_date ? `${ev.start_date}${ev.end_date && ev.end_date !== ev.start_date ? ` – ${ev.end_date}` : ""}` : null;
    const c: Ctx = { buyer: buyer.canonical_name, supplier: sup.canonical_name, event: ev.name, dates, product: parsed.product, quantity: parsed.quantity, deadline: parsed.deadline, startup, known: pk.known.slice(0, 3), deliveryLocation: cfg.deliveryLocation };
    ctx.progress("Agents are exchanging emails");
    const turns = await runPreEventConversation(missionId, c, profile);
    const gated = profile.gated.map((g) => g.topic);
    const slot = profile.meeting_slots[0] ?? null;
    addStep(missionId, "meeting", `Meeting agreed: ${sup.canonical_name}${slot ? ` — ${slot}` : ""}${profile.stand ? `, ${profile.stand}` : ""}`, "DONE", { supplier: sup.canonical_name, supplierCompanyId: profile.company_id, event: ev.name, eventId: ev.id, slot, stand: profile.stand, attendee: profile.attendees[0] ?? null, bringing: profile.bringing, knownNow: profile.shareable, onSiteOnly: profile.gated, emails: turns.length });
    await think(missionId, "What the conversation gave me", { supplier: sup.canonical_name, meeting: slot, stand: profile.stand, attendee: profile.attendees[0]?.name ?? null, learnedByEmail: profile.shareable, onlyOnSite: gated, emailsExchanged: turns.length },
      `After ${turns.length} emails I know who will be there${profile.attendees[0] ? ` (${profile.attendees[0].name})` : ""}, when we meet${slot ? ` (${slot})` : ""}, and what they will bring. ${gated.length ? `${gated.join(", ")} stay gated until we are on site, so I turn them into a checklist for your person.` : ""}`);
    setMission(missionId, { status: "MEETING_PLANNED" });
    audit({ actorType: "agent", actorId: "buyer_agent", companyId: m.company_id, action: "preevent.meeting_planned", entityType: "mission", entityId: missionId, summary: `Pre-event conversation with ${sup.canonical_name} finished in ${turns.length} emails; ${gated.length} gated topic(s) deferred to the event` });
    return { status: "MEETING_PLANNED" };
  } catch (e) {
    addStep(missionId, "error", errorMessage(e), "ERROR");
    setMission(missionId, { status: "FAILED", error: errorMessage(e) });
    throw e;
  }
}
void now; void profileFor; void CATEGORY_BY_KEY;
