import { getDb, json } from "../db/db.ts";
import { CANDIDATE_EVENT_SOURCES } from "../db/reference-data.ts";
import { ApprovalRequired, FatalTaskError, enqueueTask, registerHandler } from "./orchestrator.ts";
import { addEvent, researchEvent, resolveExhibitor } from "../services/events.ts";
import { enableMonitoring, monitorEvent } from "../services/monitoring.ts";
import { enrichCompanyFromWebsite } from "../services/enrich.ts";
import { validateVat, verifyViaGleif } from "../services/identity.ts";
import { runMatchingForSupplier } from "../services/matching.ts";
import { deriveSuppliersFromAwards } from "../services/supplier-intel.ts";
import { indexEvent } from "../services/search.ts";
import { syncTed, TED_FILTERS } from "../connectors/ted.ts";
import { syncEzamowienia } from "../connectors/ezamowienia.ts";
import { extractorFor } from "../connectors/exhibitors.ts";
import { buildBriefing, pollInbox, sendDebrief, sendFieldRequest, mailpitUrl } from "../services/field.ts";
import { runPreEventMission } from "../services/preevent.ts";
import { think } from "../services/think.ts";
import { investigate } from "../services/campaign.ts";
import { addStep, runFieldMission, runMission, setMission } from "../services/mission.ts";
import { runAutopilot } from "../services/autopilot.ts";
import { NeedsApproval, acceptOffer, currentOffer, getNegotiation, policyFor, requestApproval, submitOffer } from "../services/negotiation.ts";
import { audit } from "../lib/audit.ts";
import { now } from "../lib/util.ts";
import type { OfferTerms } from "@salespatriot/shared";

const num = (v: unknown, name: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v)) throw new FatalTaskError(`Payload field "${name}" must be an integer`);
  return v;
};

const DETAIL_BATCH = 40;

export function registerAllHandlers(): void {
  registerHandler("event.discover", async (ctx) => {
    const found: { url: string; id: number; created: boolean }[] = [];
    for (const c of CANDIDATE_EVENT_SOURCES) {
      if (ctx.isCancelled()) break;
      ctx.progress(`Checking ${c.url}`);
      const r = addEvent({ url: c.url, discoveredVia: "DISCOVERY_AGENT" });
      found.push({ url: c.url, ...r });
      if (r.created) ctx.spawn("event_research", "event.research", { eventId: r.id }, { dedupeKey: `research:${r.id}`, entityType: "event", entityId: r.id });
    }
    return { candidates: found.length, new: found.filter((f) => f.created).length };
  });

  registerHandler("event.research", async (ctx) => {
    const eventId = num(ctx.payload.eventId, "eventId");
    const report = await researchEvent(ctx, eventId);
    indexEvent(eventId);
    const db = getDb();
    if (!db.get("SELECT 1 FROM event_monitoring_jobs WHERE event_id=?", eventId)) enableMonitoring(eventId, 24 * 60);
    return report;
  });

  registerHandler("event.exhibitor_details", async (ctx) => {
    const db = getDb();
    const eventId = num(ctx.payload.eventId, "eventId");
    const ev = db.get<{ official_url: string }>("SELECT official_url FROM events WHERE id=?", eventId);
    if (!ev) throw new FatalTaskError("Event not found");
    const ex = extractorFor(ev.official_url);
    const todo = db.all<{ id: number; external_id: string | null; exhibitor_name: string; profile_url: string | null; source_url: string; evidence_text: string | null }>(
      "SELECT * FROM event_exhibitors WHERE event_id=? AND resolution_status='PENDING_DETAIL' AND removed_at IS NULL ORDER BY id LIMIT ?", eventId, DETAIL_BATCH);
    let identityCap = typeof ctx.payload.identityCap === "number" ? ctx.payload.identityCap : 15;
    let done = 0, failed = 0;
    for (const x of todo) {
      if (ctx.isCancelled()) break;
      ctx.progress(`Reading exhibitor profile ${done + 1}/${todo.length}: ${x.exhibitor_name}`);
      try {
        if (ex?.detail) {
          const rec = await ex.detail({ externalId: x.external_id, name: x.exhibitor_name, stub: true, country: null, city: null, website: null, booth: null, description: null, categories: [], profileUrl: x.profile_url, sourceUrl: x.source_url, evidence: x.evidence_text ?? "" }, { eventUrl: ev.official_url, taskId: ctx.taskId });
          if (rec.stub) throw new Error("Profile page could not be parsed");
          db.run("UPDATE event_exhibitors SET exhibitor_name=?, normalized_name=?, country=?, city=?, website=?, booth=COALESCE(?, booth), description=?, categories=?, evidence_text=?, detail_fetched_at=?, resolution_status='PENDING', profile_url=? WHERE id=?",
            rec.name, (await import("../lib/util.ts")).normalizeCompanyName(rec.name), rec.country, rec.city, rec.website, rec.booth, rec.description, JSON.stringify(rec.categories), rec.evidence, now(), rec.profileUrl, x.id);
        } else db.update("event_exhibitors", x.id, { resolution_status: "PENDING" });
        const companyId = resolveExhibitor(x.id);
        done++;
        if (companyId) {
          const c = db.get<{ website: string | null; enrichment_status: string; identity_state: string }>("SELECT website, enrichment_status, identity_state FROM companies WHERE id=?", companyId)!;
          if (c.website && c.enrichment_status === "NOT_STARTED") ctx.spawn("company_discovery", "company.enrich", { companyId }, { dedupeKey: `enrich:${companyId}`, priority: 7, entityType: "company", entityId: companyId });
          if (c.identity_state === "UNVERIFIED" && identityCap-- > 0) ctx.spawn("company_identity", "company.identity", { companyId }, { dedupeKey: `identity:${companyId}`, priority: 9, entityType: "company", entityId: companyId });
        }
      } catch (e) {
        failed++;
        // Duplicate normalized_name within the event (two slugs, same company): keep the first, mark the other as duplicate profile.
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE/.test(msg)) db.update("event_exhibitors", x.id, { resolution_status: "DUPLICATE_PROFILE", normalized_name: `dup#${x.id}` });
        else db.update("event_exhibitors", x.id, { resolution_status: "DETAIL_FAILED", evidence_text: `${x.evidence_text ?? ""} | detail error: ${msg.slice(0, 200)}` });
      }
    }
    const remaining = db.get<{ n: number }>("SELECT COUNT(*) n FROM event_exhibitors WHERE event_id=? AND resolution_status='PENDING_DETAIL' AND removed_at IS NULL", eventId)!.n;
    if (remaining > 0) ctx.spawn("event_research", "event.exhibitor_details", { eventId, identityCap, batch: (typeof ctx.payload.batch === "number" ? ctx.payload.batch : 0) + 1 }, { dedupeKey: `exh-details:${eventId}:${(typeof ctx.payload.batch === "number" ? ctx.payload.batch : 0) + 1}`, entityType: "event", entityId: eventId, priority: 6 });
    return { processed: done, failed, remaining };
  });

  registerHandler("event.monitor", async (ctx) => monitorEvent(ctx, num(ctx.payload.eventId, "eventId")));

  registerHandler("company.identity", async (ctx) => {
    const db = getDb();
    const companyId = num(ctx.payload.companyId, "companyId");
    const out: Record<string, unknown> = {};
    const ids = db.all<{ scheme: string; value: string }>("SELECT scheme, value FROM company_identifiers WHERE company_id=?", companyId);
    const c = db.get<{ country: string | null }>("SELECT country FROM companies WHERE id=?", companyId)!;
    try {
      out.gleif = await verifyViaGleif(companyId, ctx.taskId);
    } catch (e) {
      out.gleif = { error: e instanceof Error ? e.message : String(e) };
      db.run("UPDATE connector_status SET last_attempt_at=?, last_error=?, status='ERROR', failed_requests=failed_requests+1 WHERE key='gleif'", now(), String(out.gleif && (out.gleif as { error: string }).error));
    }
    const vat = ids.find((i) => i.scheme === "VAT");
    if (vat && (c.country || /^[A-Z]{2}/.test(vat.value))) {
      try { out.vies = await validateVat(companyId, /^[A-Z]{2}/.test(vat.value) ? vat.value.slice(0, 2) : c.country!, vat.value, ctx.taskId); } catch (e) { out.vies = { error: e instanceof Error ? e.message : String(e) }; }
    }
    const thens = Array.isArray(ctx.payload.next) ? (ctx.payload.then as string[]) : [];
    if (thens.includes("enrich")) ctx.spawn("company_discovery", "company.enrich", { companyId, next: thens.filter((t) => t !== "enrich") }, { dedupeKey: `enrich:${companyId}`, entityType: "company", entityId: companyId });
    else if (thens.includes("match")) ctx.spawn("matching", "matching.run", { supplierId: companyId }, { dedupeKey: `match:${companyId}`, entityType: "company", entityId: companyId });
    return out;
  });

  registerHandler("company.enrich", async (ctx) => {
    const companyId = num(ctx.payload.companyId, "companyId");
    const r = await enrichCompanyFromWebsite(companyId, ctx.taskId);
    ctx.action("company.enriched", "company", companyId, r);
    if (r.capabilities > 0) ctx.spawn("matching", "matching.run", { supplierId: companyId }, { dedupeKey: `match:${companyId}`, priority: 8, entityType: "company", entityId: companyId });
    return r;
  });

  registerHandler("matching.run", async (ctx) => ({ matches: runMatchingForSupplier(num(ctx.payload.supplierId, "supplierId")) }));

  registerHandler("procurement.sync", async (ctx) => {
    const db = getDb();
    const source = String(typeof ctx.payload.source === "string" ? ctx.payload.source : "");
    if (source === "ted") {
      const filter = (typeof ctx.payload.filter === "string" ? ctx.payload.filter : "defence_directive");
      if (!(filter in TED_FILTERS)) throw new FatalTaskError(`Unknown TED filter ${filter}`);
      const cursorKey = `ted:${filter}`;
      const cur = db.get<{ sync_cursor: string | null }>("SELECT sync_cursor FROM connector_status WHERE key='ted'");
      const cursors = json<Record<string, string>>(cur?.sync_cursor ?? null, {});
      const since = typeof ctx.payload.sinceDate === "string" ? ctx.payload.sinceDate : cursors[cursorKey] ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
      ctx.progress(`TED ${filter} since ${since}`);
      const r = await syncTed({ filter, sinceDate: since, maxRecords: typeof ctx.payload.maxRecords === "number" ? ctx.payload.maxRecords : 2000, taskId: ctx.taskId });
      if (r.cursor) {
        cursors[cursorKey] = r.cursor; // re-read a one-day overlap next time; dedupe makes it safe
        db.run("UPDATE connector_status SET sync_cursor=? WHERE key='ted'", JSON.stringify(cursors));
      }
      ctx.spawn("supplier_intelligence", "procurement.derive_suppliers", {}, { dedupeKey: "derive-suppliers", priority: 8 });
      return r;
    }
    if (source === "ezamowienia") {
      const to = new Date();
      const from = new Date(to.getTime() - (typeof ctx.payload.days === "number" ? ctx.payload.days : 2) * 86400_000);
      ctx.progress(`e-Zamówienia ${from.toISOString().slice(0, 10)}…${to.toISOString().slice(0, 10)}`);
      return syncEzamowienia({ from: from.toISOString().slice(0, 19), to: to.toISOString().slice(0, 19), maxPages: typeof ctx.payload.maxPages === "number" ? ctx.payload.maxPages : 3, cpvCode: typeof ctx.payload.cpvCode === "string" ? ctx.payload.cpvCode : undefined, taskId: ctx.taskId });
    }
    throw new FatalTaskError(`Source "${source}" has no automated sync (NSPA/EDA direct are not connected)`);
  });

  registerHandler("procurement.derive_suppliers", async () => deriveSuppliersFromAwards());

  registerHandler("field.request", async (ctx) => ({ requestId: await sendFieldRequest({ companyId: num(ctx.payload.companyId, "companyId"), repId: num(ctx.payload.repId, "repId"), eventId: typeof ctx.payload.eventId === "number" ? ctx.payload.eventId : undefined, targetCompanyId: typeof ctx.payload.targetCompanyId === "number" ? ctx.payload.targetCompanyId : undefined, standHint: typeof ctx.payload.standHint === "string" ? ctx.payload.standHint : undefined, userId: null, rfqTerms: (ctx.payload.rfqTerms ?? undefined) as Record<string, unknown> | undefined, autoNegotiate: ctx.payload.autoNegotiate === true }) }));
  registerHandler("field.poll", async (ctx) => {
    const r = await pollInbox();
    for (const id of r.repliedIds) ctx.spawn("matching", "field.briefing", { requestId: id }, { dedupeKey: `briefing:${id}`, priority: 1 });
    return r;
  });
  registerHandler("field.briefing", async (ctx) => {
    const db = getDb();
    const reqId = num(ctx.payload.requestId, "requestId");
    const { briefing, startAutopilot } = buildBriefing(reqId);
    const fr = db.get<{ mission_id: number | null; summary: string | null }>("SELECT mission_id, summary FROM field_requests WHERE id=?", reqId)!;
    if (fr.mission_id) {
      db.run("UPDATE mission_steps SET status='DONE', title='Reply received' WHERE mission_id=? AND kind='wait'", fr.mission_id);
      const sum = json<{ terms: Record<string, unknown>; gaps: string[]; photoCount?: number }>(fr.summary, { terms: {}, gaps: [] });
      addStep(fr.mission_id, "extract", `Photo & spec turned into parameters${sum.gaps.length ? ` — ${sum.gaps.length} gap(s) flagged` : ""}`, "DONE", { requestId: reqId });
      addStep(fr.mission_id, "briefing", `Briefing: ${briefing.fit.priceVsMandate}; ${briefing.matchedNotices.length} matching open tender(s)`, "DONE", briefing);
      await think(fr.mission_id, "What the salesperson's material tells me", { terms: sum.terms, gaps: sum.gaps, photos: sum.photoCount ?? 0, mandate: briefing.buyerMandate ? { maxUnitPrice: briefing.buyerMandate.maxUnitPrice, currency: briefing.buyerMandate.currency, maxLeadTimeDays: briefing.buyerMandate.maxLeadTimeDays } : null, fit: briefing.fit },
        `From the photo and documents I could read: ${Object.entries(sum.terms).map(([k, v]) => `${k} ${String(v)}`).join(", ") || "no commercial terms"}. ${briefing.fit.priceVsMandate}. ${sum.gaps.length ? `I will not guess the gaps: ${sum.gaps.join(", ")}.` : ""}`);
      if (await sendDebrief(reqId)) addStep(fr.mission_id, "debrief", "Wrote back to the salesperson with what is still missing", "DONE");
      if (startAutopilot) { setMission(fr.mission_id, { status: "NEGOTIATING", negotiation_id: startAutopilot.negotiationId }); addStep(fr.mission_id, "negotiate", "Buyer and supplier agents are negotiating by email…", "ACTIVE"); }
      else addStep(fr.mission_id, "negotiate", briefing.negotiation.decision, "ERROR");
    }
    if (startAutopilot) ctx.spawn("negotiation", "negotiation.autopilot", { negotiationId: startAutopilot.negotiationId, rfqTerms: startAutopilot.rfqTerms }, { dedupeKey: `autopilot:${startAutopilot.negotiationId}`, priority: 1 });
    return briefing;
  });
  registerHandler("campaign.investigate", async (ctx) => investigate(ctx, num(ctx.payload.missionId, "missionId")));
  registerHandler("mission.run", async (ctx) => {
    const id = num(ctx.payload.missionId, "missionId");
    const f = ctx.payload.field as { eventId: number; targetCompanyId: number; standHint: string | null; quantity: number | null; profile?: "default" | "drone" } | undefined;
    const pre = ctx.payload.preevent as { supplierCompanyId?: number } | undefined;
    const fx = f as (typeof f & { extraLines?: string[] }) | undefined;
    if (pre) return runPreEventMission(ctx, id, pre);
    return fx ? runFieldMission(ctx, id, fx) : runMission(ctx, id);
  });
  registerHandler("negotiation.autopilot", async (ctx) => {
    const negId = num(ctx.payload.negotiationId, "negotiationId");
    const r = await runAutopilot(negId, (ctx.payload.rfqTerms ?? {}) as Partial<OfferTerms>);
    const db = getDb();
    const fr = db.get<{ mission_id: number | null }>("SELECT mission_id FROM field_requests WHERE negotiation_id=?", negId);
    if (fr?.mission_id) {
      const mid = fr.mission_id;
      db.run("UPDATE mission_steps SET status='DONE', title='Buyer and supplier agents negotiated by email' WHERE mission_id=? AND kind='negotiate'", mid);
      addStep(mid, "rounds", `${db.get<{ c: number }>("SELECT COUNT(*) c FROM offers WHERE negotiation_id=?", negId)!.c} offers exchanged by email (RFQ → quotation${r.rounds ? ` → ${r.rounds} counteroffer${r.rounds > 1 ? "s" : ""}` : ""})`, "DONE", { log: r.log });
      const offers = db.all<{ version: number; kind: string; from_company_id: number; terms: string }>("SELECT version, kind, from_company_id, terms FROM offers WHERE negotiation_id=? ORDER BY version", negId).map((o) => ({ version: o.version, kind: o.kind, from: o.from_company_id === db.get<{ b: number }>("SELECT buyer_company_id b FROM negotiations WHERE id=?", negId)!.b ? "buyer" : "supplier", unitPrice: json<{ unitPrice?: number | null }>(o.terms, {}).unitPrice ?? null }));
      const bpol = db.get<{ max_unit_price: number | null; currency: string | null }>("SELECT max_unit_price, currency FROM negotiation_policies WHERE company_id=(SELECT buyer_company_id FROM negotiations WHERE id=?) AND side='BUYER'", negId);
      await think(mid, "How the negotiation went", { offers, buyerMaxUnitPrice: bpol?.max_unit_price ?? null, currency: bpol?.currency ?? null, outcome: r.outcome, humanApprovals: r.humanApprovals },
        `The supplier opened at ${offers.find((o) => o.from === "supplier")?.unitPrice ?? "an unknown price"}${bpol?.currency ? ` ${bpol.currency}` : ""}. I countered within my mandate (maximum ${bpol?.max_unit_price ?? "not set"}) and the outcome was ${r.outcome} with ${r.humanApprovals} human approvals.`);
      if (r.outcome === "DEAL") { setMission(mid, { status: "DEAL_CLOSED", deal_id: r.dealId }); addStep(mid, "deal", `DEAL CLOSED ${r.dealRef} — human approvals: ${r.humanApprovals}`, "DONE", { dealId: r.dealId, dealRef: r.dealRef }); }
      else { setMission(mid, { status: r.outcome }); addStep(mid, "deal", r.outcome === "NO_AGREEMENT" ? `No agreement within the two mandates (${r.reason ?? ""})` : `Escalated: ${r.reason ?? ""}`, "ERROR"); }
    }
    return r;
  });

  // Deterministic negotiation agent step. It reads the counterparty's offer and either accepts (only if autonomous acceptance is configured and limits hold) or counters within limits.
  registerHandler("negotiation.agent_step", async (ctx) => {
    const negId = num(ctx.payload.negotiationId, "negotiationId");
    const companyId = num(ctx.payload.companyId, "companyId");
    const n = getNegotiation(negId);
    const side = companyId === n.buyer_company_id ? "BUYER" : "SUPPLIER";
    const offer = currentOffer(n);
    if (offer.from_company_id === companyId) return { action: "none", reason: "Our own offer is on the table; waiting for the counterparty" };
    const p = policyFor(companyId, side);
    try {
      const acc = acceptOffer({ negotiationId: negId, offerId: offer.id, companyId, userId: null, agent: true, actor: `agent:${side === "BUYER" ? "buyer_agent" : "supplier_agent"}` });
      return { action: "accepted", ...acc };
    } catch (e) {
      if (!(e instanceof NeedsApproval)) throw e;
      if (!p) throw new ApprovalRequired("No negotiation limits configured; a human must decide", { negotiationId: negId });
      // Counter within limits, only changing the fields that violate them.
      const t: OfferTerms = { ...offer.terms };
      if (side === "BUYER" && p.max_unit_price != null && t.unitPrice != null && t.unitPrice > p.max_unit_price) t.unitPrice = p.max_unit_price;
      if (side === "SUPPLIER" && p.min_unit_price != null && t.unitPrice != null && t.unitPrice < p.min_unit_price) t.unitPrice = p.min_unit_price;
      if (p.max_quantity != null && t.quantity != null && t.quantity > p.max_quantity) t.quantity = p.max_quantity;
      if (p.min_quantity != null && t.quantity != null && t.quantity < p.min_quantity) t.quantity = p.min_quantity;
      if (p.max_lead_time_days != null && t.leadTimeDays != null && t.leadTimeDays > p.max_lead_time_days) t.leadTimeDays = p.max_lead_time_days;
      if (p.allowed_payment_terms && t.paymentTerms && !p.allowed_payment_terms.split(",").map((s) => s.trim().toLowerCase()).includes(t.paymentTerms.toLowerCase())) t.paymentTerms = p.allowed_payment_terms.split(",")[0]!.trim();
      try {
        const r = submitOffer({ negotiationId: negId, fromCompanyId: companyId, kind: "COUNTEROFFER", terms: t, origin: "AGENT", actor: `agent:${side === "BUYER" ? "buyer_agent" : "supplier_agent"}`, rationale: `Automatic counter within configured limits. Reasons the offer could not be accepted: ${e.reasons.join("; ")}` });
        return { action: "countered", ...r };
      } catch (e2) {
        if (e2 instanceof NeedsApproval) {
          const id = requestApproval(negId, companyId, "negotiation.continue", [...e.reasons, ...e2.reasons], { proposed: t }, `agent:${side.toLowerCase()}_agent`);
          audit({ actorType: "agent", companyId, action: "negotiation.escalated", entityType: "negotiation", entityId: negId, summary: `Escalated to human (approval ${id})` });
          return { action: "escalated", approvalId: id };
        }
        throw e2;
      }
    }
  });
}

/** Periodic scheduler tick: monitoring jobs due, procurement syncs due, stale negotiation expiry. Runs in the worker process, independent of any desktop session. */
export function schedulerTick(): { queued: number } {
  const db = getDb();
  let queued = 0;
  for (const row of db.all<{ event_id: number }>("SELECT event_id FROM event_monitoring_jobs WHERE enabled=1 AND (next_run_at IS NULL OR next_run_at <= ?)", now())) {
    // Push next_run_at forward so a slow task is not re-queued; the monitor resets it precisely on completion.
    db.run("UPDATE event_monitoring_jobs SET next_run_at=? WHERE event_id=?", new Date(Date.now() + 3600_000).toISOString(), row.event_id);
    if (enqueueTask("event_monitoring", "event.monitor", { eventId: row.event_id }, "system:scheduler", { dedupeKey: `monitor:${row.event_id}`, entityType: "event", entityId: row.event_id })) queued++;
  }
  if (mailpitUrl() && db.get("SELECT 1 FROM field_requests WHERE status IN ('REQUESTED','REPLIED')") && enqueueTask("email", "field.poll", {}, "system:scheduler", { dedupeKey: "field-poll", priority: 1 })) queued++;
  // Demand whose submission deadline has passed is no longer current demand.
  db.run("UPDATE procurement_notices SET demand_class='HISTORICAL_DEMAND', procurement_status='CLOSED' WHERE demand_class='CONFIRMED_DEMAND' AND deadline IS NOT NULL AND deadline < ?", now());
  const every = Number(process.env.PROCUREMENT_SYNC_MINUTES ?? 360) * 60_000;
  const due = (key: string) => { const s = db.get<{ last_attempt_at: string | null }>("SELECT last_attempt_at FROM connector_status WHERE key=?", key); return !s?.last_attempt_at || Date.now() - Date.parse(s.last_attempt_at) > every; };
  if (process.env.PROCUREMENT_AUTOSYNC !== "off") {
    if (due("ted")) for (const filter of ["defence_directive", "agencja_uzbrojenia", "eda"]) if (enqueueTask("buyer_intelligence", "procurement.sync", { source: "ted", filter }, "system:scheduler", { dedupeKey: `sync:ted:${filter}`, priority: 4 })) queued++;
    if (due("ezamowienia") && enqueueTask("buyer_intelligence", "procurement.sync", { source: "ezamowienia" }, "system:scheduler", { dedupeKey: "sync:ezamowienia", priority: 4 })) queued++;
  }
  return { queued };
}
