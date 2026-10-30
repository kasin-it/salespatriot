import type { OfferTerms } from "@salespatriot/shared";
import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import * as n from "./negotiation.ts";
import { mailboxReady, readOfferEmail, sendOfferEmail } from "./mailneg.ts";

export interface AutopilotResult {
  outcome: "DEAL" | "NO_AGREEMENT" | "ESCALATED";
  dealId: number | null;
  dealRef: string | null;
  rounds: number;
  humanApprovals: number;
  log: string[];
  reason?: string;
}

const MAX_STEPS = 16; // loop guard only; the real limits are each company's configured max_rounds

/**
 * Two company agents negotiate end to end with no human in the loop. Every number comes from a company's own configured mandate
 * (opening terms and limits) or from the counterparty's actual offers. If a mandate is missing a required opening term,
 * the run stops and escalates instead of inventing one.
 */
export async function runAutopilot(negId: number, rfqTerms: Partial<OfferTerms>): Promise<AutopilotResult> {
  const db = getDb();
  const log: string[] = [];
  const neg0 = n.getNegotiation(negId);
  const buyer = neg0.buyer_company_id, supplier = neg0.supplier_company_id;
  const names = new Map(db.all<{ id: number; canonical_name: string }>("SELECT id, canonical_name FROM companies WHERE id IN (?, ?)", buyer, supplier).map((r) => [r.id, r.canonical_name]));
  const useMail = mailboxReady();
  if (!useMail) log.push("Email transport not configured (SMTP_* / MAILPIT_URL): offers are exchanged in the database only");
  /** Sends the offer as a real email, then lets the receiving agent read it back from the mailbox and verify it matches the recorded offer. */
  const viaEmail = async (offerId: number, from: "buyer" | "supplier") => {
    if (!useMail) return;
    const o = db.get<{ version: number; kind: string; terms: string; previous_offer_id: number | null; rationale: string | null }>("SELECT * FROM offers WHERE id=?", offerId)!;
    const prev = o.previous_offer_id ? db.get<{ version: number }>("SELECT version FROM offers WHERE id=?", o.previous_offer_id)!.version : null;
    const terms = json<OfferTerms>(o.terms, n.emptyTerms());
    try {
      await sendOfferEmail({ negId, version: o.version, kind: o.kind, subject: neg0.subject, from, fromName: names.get(from === "buyer" ? buyer : supplier)!, toName: names.get(from === "buyer" ? supplier : buyer)!, terms, previousVersion: prev, rationale: o.rationale, mode: neg0.mode });
      const got = await readOfferEmail(negId, o.version);
      const reader = from === "buyer" ? "Supplier" : "Buyer";
      if (!got) log.push(`${reader} agent could not read v${o.version} from the mailbox; using the recorded offer`);
      else if (JSON.stringify(got.terms) !== JSON.stringify(terms)) throw new Error(`Mailbox copy of v${o.version} differs from the recorded offer`);
      else log.push(`${reader} agent read ${o.kind} v${o.version} from the mailbox (verified identical)`);
    } catch (e) { log.push(`Email step failed: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const bp = n.policyFor(buyer, "BUYER"), sp = n.policyFor(supplier, "SUPPLIER");
  const done = (r: Omit<AutopilotResult, "rounds" | "humanApprovals" | "log">): AutopilotResult => {
    const humanApprovals = db.get<{ c: number }>("SELECT COUNT(*) c FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND decided_by_user_id IS NOT NULL", negId)!.c;
    audit({ actorType: "agent", actorId: "negotiation", entityType: "negotiation", entityId: negId, action: "autopilot.finished", summary: `Autopilot ${r.outcome}${r.reason ? `: ${r.reason}` : ""} (human approvals: ${humanApprovals})` });
    return { ...r, rounds: n.getNegotiation(negId).round, humanApprovals, log };
  };
  const escalate = (company: number, reasons: string[]) => {
    n.requestApproval(negId, company, "negotiation.autopilot", reasons, {}, "agent:negotiation");
    log.push(`ESCALATED: ${reasons.join("; ")}`);
    return done({ outcome: "ESCALATED", dealId: null, dealRef: null, reason: reasons.join("; ") });
  };
  if (!sp?.autonomous_accept || !bp?.autonomous_accept) return escalate(!bp?.autonomous_accept ? buyer : supplier, ["Both companies must enable autonomous acceptance in their mandate for a no-human run"]);

  for (let step = 0; step < MAX_STEPS; step++) {
    const neg = n.getNegotiation(negId);
    if (neg.state === "ACCEPTED") break;
    if (["REJECTED", "EXPIRED", "CANCELLED"].includes(neg.state)) return done({ outcome: "NO_AGREEMENT", dealId: null, dealRef: null, reason: neg.state });

    if (neg.state === "INITIAL_CONTACT") {
      const terms = { ...n.emptyTerms(), ...rfqTerms };
      const r0 = n.submitOffer({ negotiationId: negId, fromCompanyId: buyer, kind: "RFQ", terms, origin: "AGENT", actor: "agent:buyer_agent", rationale: "RFQ from buyer mandate" });
      await viaEmail(r0.offerId, "buyer");
      log.push(`Buyer agent sent RFQ: qty ${terms.quantity ?? "n/a"}`);
      continue;
    }
    if (neg.state === "RFQ_SENT") {
      const rfq = n.currentOffer(neg).terms;
      const missing = (["opening_unit_price", "opening_lead_time_days", "opening_payment_terms", "opening_delivery_terms", "opening_validity_days"] as const).filter((k) => sp[k] == null);
      if (missing.length) return escalate(supplier, [`Supplier mandate lacks opening terms: ${missing.join(", ")} — the agent will not invent them`]);
      if (!sp.currency) return escalate(supplier, ["Supplier mandate has no currency"]);
      const terms: OfferTerms = { ...n.emptyTerms(), ...rfq, unitPrice: sp.opening_unit_price, currency: sp.currency, leadTimeDays: sp.opening_lead_time_days, paymentTerms: sp.opening_payment_terms, deliveryTerms: sp.opening_delivery_terms,
        quantity: rfq.quantity, validUntil: new Date(Date.now() + sp.opening_validity_days! * 86400_000).toISOString() };
      try {
        const r1 = n.submitOffer({ negotiationId: negId, fromCompanyId: supplier, kind: "QUOTATION", terms, origin: "AGENT", actor: "agent:supplier_agent", rationale: "Quotation from supplier mandate opening terms" });
        await viaEmail(r1.offerId, "supplier");
      } catch (e) { if (e instanceof n.NeedsApproval) return escalate(supplier, e.reasons); throw e; }
      log.push(`Supplier agent quoted ${terms.unitPrice} ${terms.currency}, lead ${terms.leadTimeDays} d`);
      continue;
    }
    // Someone holds a counterparty offer: the other side responds.
    const offer = n.currentOffer(neg);
    const responder = offer.from_company_id === buyer ? supplier : buyer;
    const side = responder === buyer ? "BUYER" : "SUPPLIER";
    const actor = side === "BUYER" ? "agent:buyer_agent" : "agent:supplier_agent";
    try {
      const r = n.acceptOffer({ negotiationId: negId, offerId: offer.id, companyId: responder, userId: null, agent: true, actor });
      log.push(`${side} agent accepted v${offer.version}`);
      if (r.dealId) {
        if (useMail) { try { const t = (await import("nodemailer")).default.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true" }); await t.sendMail({ from: (await import("./mailneg.ts")).agentAddress(side === "BUYER" ? "buyer" : "supplier"), to: (await import("./mailneg.ts")).agentAddress(side === "BUYER" ? "supplier" : "buyer"), subject: `[NEG-${negId}] ACCEPTED v${offer.version} — ${r.dealRef}`, text: `${side} agent accepted offer v${offer.version} within its mandate. Deal record ${r.dealRef}${neg0.mode === "SANDBOX" ? " (SANDBOX simulation; not a signed contract)" : ""}.` }); log.push("Acceptance confirmation emailed"); } catch { log.push("Acceptance email failed"); } }
        return done({ outcome: "DEAL", dealId: r.dealId, dealRef: r.dealRef });
      }
      continue;
    } catch (e) {
      if (!(e instanceof n.NeedsApproval)) throw e;
    }
    const p = side === "BUYER" ? bp : sp;
    const t: OfferTerms = { ...offer.terms };
    const mine = db.all<{ terms: string }>("SELECT terms FROM offers WHERE negotiation_id=? AND from_company_id=? ORDER BY version DESC LIMIT 1", negId, responder)[0];
    const lastOwn = mine ? json<OfferTerms>(mine.terms, n.emptyTerms()).unitPrice : null;
    const open = side === "BUYER" ? bp.opening_unit_price : sp.opening_unit_price;
    const theirs = offer.terms.unitPrice;
    if (theirs != null) {
      const from = lastOwn ?? open ?? (side === "BUYER" ? p.max_unit_price : p.min_unit_price);
      if (from == null) return escalate(responder, [`${side} mandate has no price anchor to counter from`]);
      let price = from + (theirs - from) * 0.5; // concede half the remaining gap per round
      if (side === "BUYER" && p.max_unit_price != null) price = Math.min(price, p.max_unit_price);
      if (side === "SUPPLIER" && p.min_unit_price != null) price = Math.max(price, p.min_unit_price);
      price = Math.round(price * 100) / 100;
      if (lastOwn != null && Math.abs(price - lastOwn) < 0.005 && Math.abs(theirs - price) > 0.005) {
        // At my limit and the other side's offer is still unacceptable: no overlap in mandates.
        const closer = side === "BUYER" ? theirs > (p.max_unit_price ?? Infinity) : theirs < (p.min_unit_price ?? -Infinity);
        if (closer) { n.reject(negId, actor, "No overlap between the parties' mandates"); log.push(`${side} agent rejected: no overlap in mandates`); return done({ outcome: "NO_AGREEMENT", dealId: null, dealRef: null, reason: "No overlap between mandates" }); }
      }
      t.unitPrice = price;
    }
    if (p.max_quantity != null && t.quantity != null && t.quantity > p.max_quantity) t.quantity = p.max_quantity;
    if (p.min_quantity != null && t.quantity != null && t.quantity < p.min_quantity) t.quantity = p.min_quantity;
    if (p.max_lead_time_days != null && t.leadTimeDays != null && t.leadTimeDays > p.max_lead_time_days) t.leadTimeDays = p.max_lead_time_days;
    if (p.allowed_payment_terms && t.paymentTerms && !p.allowed_payment_terms.split(",").map((s) => s.trim().toLowerCase()).includes(t.paymentTerms.toLowerCase())) t.paymentTerms = p.allowed_payment_terms.split(",")[0]!.trim();
    try {
      const rc = n.submitOffer({ negotiationId: negId, fromCompanyId: responder, kind: "COUNTEROFFER", terms: t, origin: "AGENT", actor, rationale: "Counter within mandate (concedes half the gap per round)" });
      await viaEmail(rc.offerId, side === "BUYER" ? "buyer" : "supplier");
    } catch (e) {
      if (e instanceof n.NeedsApproval) return escalate(responder, e.reasons);
      throw e;
    }
    log.push(`${side} agent countered at ${t.unitPrice}`);
  }
  const final = n.getNegotiation(negId);
  const deal = db.get<{ id: number; deal_ref: string }>("SELECT id, deal_ref FROM deals WHERE negotiation_id=?", negId);
  if (deal) return done({ outcome: "DEAL", dealId: deal.id, dealRef: deal.deal_ref });
  return done({ outcome: "NO_AGREEMENT", dealId: null, dealRef: null, reason: `Stopped in ${final.state} after ${MAX_STEPS} steps` });
}
