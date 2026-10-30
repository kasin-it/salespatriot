import { REQUIRED_OFFER_TERMS, TERMINAL_NEGOTIATION_STATES, type NegotiationState, type OfferTerms, type TransactionMode } from "@salespatriot/shared";
import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { now, randomToken } from "../lib/util.ts";

export class NegotiationError extends Error {}
/** Raised when an action needs a human decision; callers persist an approval and stop. */
export class NeedsApproval extends Error {
  reasons: string[];
  constructor(reasons: string[]) {
    super(reasons.join("; "));
    this.reasons = reasons;
  }
}

const TRANSITIONS: Record<NegotiationState, NegotiationState[]> = {
  INITIAL_CONTACT: ["REQUIREMENTS_CLARIFICATION", "RFQ_SENT", "CANCELLED"],
  REQUIREMENTS_CLARIFICATION: ["RFQ_SENT", "CANCELLED"],
  RFQ_SENT: ["QUOTATION_RECEIVED", "REQUIREMENTS_CLARIFICATION", "EXPIRED", "CANCELLED", "REJECTED"],
  QUOTATION_RECEIVED: ["COUNTEROFFER", "NEGOTIATION", "TERMS_AGREED", "PENDING_ACCEPTANCE", "REJECTED", "EXPIRED", "CANCELLED"],
  COUNTEROFFER: ["COUNTEROFFER", "NEGOTIATION", "TERMS_AGREED", "PENDING_ACCEPTANCE", "REJECTED", "EXPIRED", "CANCELLED"],
  NEGOTIATION: ["COUNTEROFFER", "TERMS_AGREED", "PENDING_ACCEPTANCE", "REJECTED", "EXPIRED", "CANCELLED"],
  TERMS_AGREED: ["PENDING_ACCEPTANCE", "COUNTEROFFER", "REJECTED", "EXPIRED", "CANCELLED"],
  PENDING_ACCEPTANCE: ["ACCEPTED", "COUNTEROFFER", "REJECTED", "EXPIRED", "CANCELLED"],
  ACCEPTED: [],
  REJECTED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export const canTransition = (from: NegotiationState, to: NegotiationState): boolean => TRANSITIONS[from].includes(to);

interface Neg {
  id: number; mode: TransactionMode; buyer_company_id: number; supplier_company_id: number; state: NegotiationState; round: number;
  current_offer_id: number | null; origin_event_id: number | null; subject: string; buyer_policy_snapshot: string | null; supplier_policy_snapshot: string | null;
}

export interface Policy {
  currency: string | null; max_unit_price: number | null; min_unit_price: number | null; max_quantity: number | null; min_quantity: number | null;
  max_discount_pct: number | null; allowed_payment_terms: string | null; max_lead_time_days: number | null; max_rounds: number | null;
  simulated: number; autonomous_accept: number; approval_required_above_total: number | null;
  opening_unit_price: number | null; opening_lead_time_days: number | null; opening_payment_terms: string | null; opening_delivery_terms: string | null; opening_validity_days: number | null;
}

export const getNegotiation = (id: number): Neg => {
  const n = getDb().get<Neg>("SELECT * FROM negotiations WHERE id = ?", id);
  if (!n) throw new NegotiationError(`Negotiation ${id} not found`);
  return n;
};

function transition(n: Neg, to: NegotiationState, actor: string, reason: string): void {
  if (!canTransition(n.state, to)) throw new NegotiationError(`Illegal transition ${n.state} → ${to}`);
  const db = getDb();
  db.update("negotiations", n.id, { state: to, updated_at: now() });
  db.insert("negotiation_transitions", { negotiation_id: n.id, from_state: n.state, to_state: to, actor, reason });
  n.state = to;
}

export function policyFor(companyId: number, side: "BUYER" | "SUPPLIER"): Policy | undefined {
  return getDb().get<Policy>("SELECT * FROM negotiation_policies WHERE company_id = ? AND side = ?", companyId, side);
}

export function setPolicy(companyId: number, side: "BUYER" | "SUPPLIER", p: Partial<Policy>, userId: number): void {
  const db = getDb();
  const vals = { ...p, updated_by_user_id: userId, updated_at: now() } as Record<string, string | number | null>;
  const exists = db.get("SELECT id FROM negotiation_policies WHERE company_id=? AND side=?", companyId, side);
  if (exists) db.run(`UPDATE negotiation_policies SET ${Object.keys(vals).map((k) => `${k}=?`).join(", ")} WHERE company_id=? AND side=?`, ...Object.values(vals), companyId, side);
  else db.insert("negotiation_policies", { company_id: companyId, side, ...vals });
  audit({ actorType: "user", actorId: userId, companyId, action: "policy.updated", summary: `${side} negotiation limits updated`, detail: p });
}

export function createNegotiation(a: { buyerId: number; supplierId: number; subject: string; mode: TransactionMode; userId: number | null; requirementId?: number; offeringId?: number; matchId?: number; eventId?: number | null }): number {
  const db = getDb();
  if (a.buyerId === a.supplierId) throw new NegotiationError("Buyer and supplier must be different companies");
  for (const id of [a.buyerId, a.supplierId]) {
    const c = db.get<{ identity_state: string; is_registered: number; canonical_name: string }>("SELECT identity_state, is_registered, canonical_name FROM companies WHERE id = ?", id);
    if (!c) throw new NegotiationError(`Company ${id} not found`);
    // REAL needs a registry-identified company. SANDBOX may use public records whose identity rests on an official event listing, but never an INACTIVE company.
    const ok = a.mode === "REAL" ? ["IDENTIFIED", "VERIFIED"].includes(c.identity_state) : c.identity_state !== "INACTIVE";
    if (!ok) throw new NegotiationError(`${c.canonical_name} is not identified (state ${c.identity_state}); resolve identity first`);
    if (a.mode === "REAL" && !c.is_registered) throw new NegotiationError(`${c.canonical_name} has no authorised Arsenal AI account; a REAL negotiation cannot be run on its behalf. Use SANDBOX or contact them through a legitimate channel.`);
  }
  if (a.mode === "REAL") for (const [id, side] of [[a.buyerId, "BUYER"], [a.supplierId, "SUPPLIER"]] as const) {
    if (getDb().get("SELECT 1 FROM negotiation_policies WHERE company_id=? AND side=? AND simulated=1", id, side)) throw new NegotiationError("A simulated (SANDBOX) mandate exists for this company; it can never be used in a REAL negotiation");
  }
  const snap = (id: number, side: "BUYER" | "SUPPLIER") => JSON.stringify(policyFor(id, side) ?? null);
  const id = db.insert("negotiations", {
    mode: a.mode, buyer_company_id: a.buyerId, supplier_company_id: a.supplierId, subject: a.subject, state: "INITIAL_CONTACT", buyer_requirement_id: a.requirementId ?? null,
    supplier_offering_id: a.offeringId ?? null, match_id: a.matchId ?? null, origin_event_id: a.eventId ?? null, created_by_user_id: a.userId,
    buyer_policy_snapshot: snap(a.buyerId, "BUYER"), supplier_policy_snapshot: snap(a.supplierId, "SUPPLIER"),
  });
  db.insert("negotiation_transitions", { negotiation_id: id, from_state: null, to_state: "INITIAL_CONTACT", actor: a.userId ? `user:${a.userId}` : "system", reason: "created" });
  audit({ actorType: "user", actorId: a.userId, companyId: a.buyerId, action: "negotiation.created", entityType: "negotiation", entityId: id, summary: `${a.mode} negotiation created: ${a.subject}` });
  return id;
}

export const emptyTerms = (): OfferTerms => ({ unitPrice: null, currency: null, quantity: null, moq: null, deliveryTerms: null, deliveryLocation: null, leadTimeDays: null, paymentTerms: null, warranty: null, technicalSpecs: null, validUntil: null });

export function missingTerms(t: OfferTerms): string[] {
  return REQUIRED_OFFER_TERMS.filter((k) => t[k] === null || t[k] === "" || t[k] === undefined) as string[];
}

/** Deterministic limit check for terms proposed BY `companyId` acting on `side`. Returns violated limits (empty = within authority). */
export function checkLimits(p: Policy | undefined, side: "BUYER" | "SUPPLIER", t: OfferTerms, round: number): string[] {
  if (!p) return [`No ${side.toLowerCase()} negotiation limits are configured for this company; human approval required`];
  const v: string[] = [];
  if (p.currency && t.currency && p.currency !== t.currency) v.push(`Currency ${t.currency} differs from configured ${p.currency}`);
  if (t.unitPrice != null) {
    if (side === "BUYER" && p.max_unit_price != null && t.unitPrice > p.max_unit_price) v.push(`Unit price ${t.unitPrice} exceeds maximum purchase price ${p.max_unit_price}`);
    if (side === "SUPPLIER" && p.min_unit_price != null && t.unitPrice < p.min_unit_price) v.push(`Unit price ${t.unitPrice} is below minimum sale price ${p.min_unit_price}`);
    if (side === "BUYER" && p.max_unit_price == null) v.push("No maximum purchase price configured");
    if (side === "SUPPLIER" && p.min_unit_price == null) v.push("No minimum sale price configured");
  }
  if (t.quantity != null) {
    if (p.max_quantity != null && t.quantity > p.max_quantity) v.push(`Quantity ${t.quantity} exceeds maximum ${p.max_quantity}`);
    if (p.min_quantity != null && t.quantity < p.min_quantity) v.push(`Quantity ${t.quantity} is below minimum ${p.min_quantity}`);
  }
  if (t.paymentTerms && p.allowed_payment_terms) {
    const allowed = p.allowed_payment_terms.split(",").map((s) => s.trim().toLowerCase());
    if (!allowed.includes(t.paymentTerms.toLowerCase())) v.push(`Payment terms "${t.paymentTerms}" not in permitted list (${p.allowed_payment_terms})`);
  }
  if (t.leadTimeDays != null && p.max_lead_time_days != null && t.leadTimeDays > p.max_lead_time_days) v.push(`Lead time ${t.leadTimeDays} d exceeds ${p.max_lead_time_days} d`);
  if (p.max_rounds != null && round > p.max_rounds) v.push(`Round ${round} exceeds maximum rounds ${p.max_rounds}`);
  if (p.approval_required_above_total != null && t.unitPrice != null && t.quantity != null && t.unitPrice * t.quantity > p.approval_required_above_total) v.push(`Total ${t.unitPrice * t.quantity} exceeds approval threshold ${p.approval_required_above_total}`);
  return v;
}

export interface SubmitOfferInput {
  negotiationId: number;
  fromCompanyId: number;
  kind: "RFQ" | "QUOTATION" | "COUNTEROFFER";
  terms: OfferTerms;
  origin: "HUMAN" | "AGENT" | "EXTERNAL_RECORDED";
  actor: string;
  rationale?: string;
  /** For human-entered offers a user with signing authority has already approved the limit exceedance. */
  approvedApprovalId?: number;
}

/** Record a structured, versioned offer. Counteroffers reference the previous version. Out-of-limit offers by agents never get persisted as sent; an approval is requested. */
export function submitOffer(i: SubmitOfferInput): { offerId: number; version: number } {
  const db = getDb();
  return db.tx(() => {
    const n = getNegotiation(i.negotiationId);
    if (TERMINAL_NEGOTIATION_STATES.includes(n.state)) throw new NegotiationError(`Negotiation is ${n.state}`);
    if (![n.buyer_company_id, n.supplier_company_id].includes(i.fromCompanyId)) throw new NegotiationError("Sender is not a party to this negotiation");
    const side = i.fromCompanyId === n.buyer_company_id ? "BUYER" : "SUPPLIER";
    const to = side === "BUYER" ? n.supplier_company_id : n.buyer_company_id;
    if (i.kind === "RFQ" && side !== "BUYER") throw new NegotiationError("Only the buyer sends an RFQ");
    if (i.kind === "QUOTATION" && side !== "SUPPLIER") throw new NegotiationError("Only the supplier sends a quotation");
    if (i.terms.validUntil && Date.parse(i.terms.validUntil) <= Date.now()) throw new NegotiationError("Offer validity date is already in the past");
    const round = i.kind === "COUNTEROFFER" ? n.round + 1 : n.round;
    if (i.kind !== "RFQ") {
      const violations = checkLimits(policyFor(i.fromCompanyId, side), side, i.terms, round);
      if (violations.length && !(i.approvedApprovalId && approvalCovers(i.approvedApprovalId, n.id, i.fromCompanyId))) {
        // Agents and external-recorded offers cannot bypass limits. Humans must approve explicitly via the approvals flow.
        if (i.origin === "EXTERNAL_RECORDED") {
          // Recording what the counterparty actually sent is a fact, not a decision; flag it but keep it.
        } else throw new NeedsApproval(violations);
      }
    }
    const prev = n.current_offer_id;
    const version = (db.get<{ v: number }>("SELECT COALESCE(MAX(version),0) v FROM offers WHERE negotiation_id=?", n.id)?.v ?? 0) + 1;
    const offerId = db.insert("offers", {
      negotiation_id: n.id, version, previous_offer_id: prev, kind: i.kind, from_company_id: i.fromCompanyId, to_company_id: to, terms: JSON.stringify(i.terms),
      status: "OPEN", mode: n.mode, origin: i.origin, rationale: i.rationale ?? null, created_by: i.actor,
    });
    if (prev) db.run("UPDATE offers SET status='SUPERSEDED' WHERE id=? AND status='OPEN'", prev);
    db.update("negotiations", n.id, { current_offer_id: offerId, round, updated_at: now() });
    if (i.kind === "RFQ") {
      transition(n, "RFQ_SENT", i.actor, "RFQ recorded");
      db.insert("rfqs", { negotiation_id: n.id, buyer_company_id: n.buyer_company_id, supplier_company_id: n.supplier_company_id, requested_terms: JSON.stringify(i.terms), body: i.rationale ?? null, mode: n.mode, status: "SENT", created_by: i.actor });
    } else if (i.kind === "QUOTATION") {
      if (n.state === "RFQ_SENT") transition(n, "QUOTATION_RECEIVED", i.actor, "quotation recorded");
      else transition(n, "COUNTEROFFER", i.actor, "quotation revised");
      const rfq = db.get<{ id: number }>("SELECT id FROM rfqs WHERE negotiation_id=? ORDER BY id DESC LIMIT 1", n.id);
      if (rfq) db.insert("quotations", { rfq_id: rfq.id, offer_id: offerId, supplier_company_id: i.fromCompanyId, mode: n.mode });
    } else transition(n, "COUNTEROFFER", i.actor, `counteroffer v${version} refers to v${version - 1}`);
    audit({ actorType: i.origin === "AGENT" ? "agent" : "user", actorId: i.actor, companyId: i.fromCompanyId, action: `offer.${i.kind.toLowerCase()}`, entityType: "negotiation", entityId: n.id, summary: `${n.mode} ${i.kind} v${version}`, detail: i.terms });
    return { offerId, version };
  });
}

const approvalCovers = (approvalId: number, negId: number, companyId: number): boolean =>
  !!getDb().get("SELECT id FROM approvals WHERE id=? AND status='APPROVED' AND entity_type='negotiation' AND entity_id=? AND company_id=?", approvalId, negId, companyId);

export function requestApproval(negId: number, companyId: number, action: string, reasons: string[], payload: unknown, by: string): number {
  const db = getDb();
  const id = db.insert("approvals", { company_id: companyId, entity_type: "negotiation", entity_id: negId, action, reason: reasons.join("; "), payload: JSON.stringify(payload), requested_by: by });
  audit({ actorType: "agent", actorId: by, companyId, action: "approval.requested", entityType: "approval", entityId: id, summary: reasons.join("; ") });
  return id;
}

export function markTermsAgreed(negId: number, actor: string): void {
  const n = getNegotiation(negId);
  const offer = currentOffer(n);
  const missing = missingTerms(offer.terms);
  if (missing.length) throw new NegotiationError(`Required terms missing: ${missing.join(", ")}`);
  transition(n, "TERMS_AGREED", actor, "both sides reference same terms");
  transition(n, "PENDING_ACCEPTANCE", actor, "awaiting acceptance by both parties");
}

export function currentOffer(n: Neg): { id: number; version: number; from_company_id: number; terms: OfferTerms; status: string } {
  if (!n.current_offer_id) throw new NegotiationError("No offer on the table");
  const o = getDb().get<{ id: number; version: number; from_company_id: number; terms: string; status: string }>("SELECT * FROM offers WHERE id=?", n.current_offer_id)!;
  return { ...o, terms: json<OfferTerms>(o.terms, emptyTerms()) };
}

export interface AcceptInput { negotiationId: number; offerId: number; companyId: number; userId: number | null; agent: boolean; actor: string }

/**
 * Acceptance by one party of a specific offer version. Deal is created only when BOTH parties accepted the SAME offer version
 * and every precondition holds. Acceptance by an agent additionally requires configured autonomous_accept and in-limit terms.
 */
export function acceptOffer(i: AcceptInput): { dealId: number | null; dealRef: string | null; pending: string[] } {
  const db = getDb();
  return db.tx(() => {
    const n = getNegotiation(i.negotiationId);
    if (TERMINAL_NEGOTIATION_STATES.includes(n.state)) throw new NegotiationError(`Negotiation is ${n.state}`);
    if (![n.buyer_company_id, n.supplier_company_id].includes(i.companyId)) throw new NegotiationError("Not a party");
    const offer = currentOffer(n);
    if (offer.id !== i.offerId) throw new NegotiationError("Only the current offer version can be accepted; it has been superseded");
    if (offer.from_company_id === i.companyId) throw new NegotiationError("A party cannot accept its own offer; the counterparty must accept it");
    const side = i.companyId === n.buyer_company_id ? "BUYER" : "SUPPLIER";
    const t = offer.terms;
    const missing = missingTerms(t);
    if (missing.length) throw new NeedsApproval([`Required commercial terms missing: ${missing.join(", ")}`]);
    if (t.validUntil && Date.parse(t.validUntil) <= Date.now()) { markExpired(n.id, "offer validity elapsed"); throw new NegotiationError("Offer has expired"); }
    const co = db.get<{ identity_state: string; is_registered: number }>("SELECT identity_state, is_registered FROM companies WHERE id=?", i.companyId)!;
    if (n.mode === "REAL" ? !["IDENTIFIED", "VERIFIED"].includes(co.identity_state) : co.identity_state === "INACTIVE") throw new NegotiationError("Accepting company is not identified");
    let basis: string;
    if (i.agent) {
      const p = policyFor(i.companyId, side);
      if (!p?.autonomous_accept) throw new NeedsApproval(["Autonomous acceptance is not enabled for this company; human approval required"]);
      const violations = checkLimits(p, side, t, n.round);
      if (violations.length) throw new NeedsApproval(violations);
      basis = "agent within configured limits (autonomous_accept)";
    } else {
      if (!i.userId) throw new NegotiationError("A human acceptance needs a user");
      const m = db.get<{ authorization_level: string }>("SELECT authorization_level FROM company_memberships WHERE user_id=? AND company_id=?", i.userId, i.companyId);
      if (!m || m.authorization_level !== "SIGNATORY") throw new NegotiationError("User lacks signing authority (authorization level SIGNATORY) for this company");
      basis = `user ${i.userId} with SIGNATORY authorization`;
    }
    const pendingApproval = db.get("SELECT id FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND status='PENDING'", n.id);
    if (pendingApproval) throw new NeedsApproval(["An approval is still pending for this negotiation"]);
    if (n.state === "COUNTEROFFER" || n.state === "QUOTATION_RECEIVED" || n.state === "NEGOTIATION") {
      transition(n, "TERMS_AGREED", i.actor, "party accepted current terms");
      transition(n, "PENDING_ACCEPTANCE", i.actor, "awaiting remaining acceptance");
    }
    db.run("INSERT OR IGNORE INTO offer_acceptances (offer_id, company_id, accepted_by, user_id, authorization_basis) VALUES (?,?,?,?,?)", offer.id, i.companyId, i.actor, i.userId, basis);
    audit({ actorType: i.agent ? "agent" : "user", actorId: i.actor, companyId: i.companyId, action: "offer.accepted_by_party", entityType: "negotiation", entityId: n.id, summary: `${side} accepted offer v${offer.version} (${basis})` });
    const both = db.all<{ company_id: number }>("SELECT company_id FROM offer_acceptances WHERE offer_id=?", offer.id).map((r) => r.company_id);
    // The offering party's acceptance is implicit in having sent it; it is recorded as such, with its own authorization basis.
    if (!both.includes(offer.from_company_id)) {
      const originRow = db.get<{ created_by: string; origin: string }>("SELECT created_by, origin FROM offers WHERE id=?", offer.id)!;
      db.run("INSERT OR IGNORE INTO offer_acceptances (offer_id, company_id, accepted_by, authorization_basis) VALUES (?,?,?,?)", offer.id, offer.from_company_id, originRow.created_by, `issuer of the offer (${originRow.origin})`);
    }
    return finalizeDeal(n, offer, i.actor);
  });
}

function finalizeDeal(n: Neg, offer: { id: number; version: number; terms: OfferTerms }, actor: string): { dealId: number | null; dealRef: string | null; pending: string[] } {
  const db = getDb();
  const accepted = new Set(db.all<{ company_id: number }>("SELECT company_id FROM offer_acceptances WHERE offer_id=?", offer.id).map((r) => r.company_id));
  const pending = [n.buyer_company_id, n.supplier_company_id].filter((c) => !accepted.has(c)).map((c) => `Acceptance by company ${c}`);
  if (pending.length) return { dealId: null, dealRef: null, pending };
  transition(n, "ACCEPTED", actor, `both parties accepted offer v${offer.version}`);
  db.update("offers", offer.id, { status: "ACCEPTED" });
  const ref = `${n.mode === "SANDBOX" ? "SBX" : "DEAL"}-${new Date().getUTCFullYear()}-${randomToken(4).toUpperCase()}`;
  const t = offer.terms;
  const total = t.unitPrice != null && t.quantity != null ? t.unitPrice * t.quantity : null;
  const dealId = db.insert("deals", {
    deal_ref: ref, negotiation_id: n.id, offer_id: offer.id, buyer_company_id: n.buyer_company_id, supplier_company_id: n.supplier_company_id, origin_event_id: n.origin_event_id,
    subject: n.subject, terms: JSON.stringify(t), total_value: total, currency: t.currency, mode: n.mode, status: "ACCEPTED_NOT_A_SIGNED_CONTRACT",
  });
  db.insert("deal_events", { deal_id: dealId, kind: "DEAL_RECORDED", summary: `Offer v${offer.version} accepted by both parties. This is a recorded commercial acceptance, not a legally executed contract.`, actor, payload: JSON.stringify({ acceptances: db.all("SELECT * FROM offer_acceptances WHERE offer_id=?", offer.id) }) });
  audit({ actorType: "system", action: "deal.recorded", entityType: "deal", entityId: dealId, summary: `${n.mode} deal ${ref} recorded${n.mode === "SANDBOX" ? " (SANDBOX — not a real transaction)" : ""}` });
  return { dealId, dealRef: ref, pending: [] };
}

export function reject(negId: number, actor: string, reason: string): void {
  transition(getNegotiation(negId), "REJECTED", actor, reason);
  audit({ actorType: "user", actorId: actor, action: "negotiation.rejected", entityType: "negotiation", entityId: negId, summary: `Negotiation rejected: ${reason}` });
}
export function cancel(negId: number, actor: string, reason: string): void {
  transition(getNegotiation(negId), "CANCELLED", actor, reason);
}
export function markExpired(negId: number, reason: string): void {
  const n = getNegotiation(negId);
  if (canTransition(n.state, "EXPIRED")) transition(n, "EXPIRED", "system", reason);
}

/** Sweep: expire open negotiations whose current offer validity has elapsed. */
export function expireStaleNegotiations(): number {
  const db = getDb();
  let c = 0;
  for (const n of db.all<Neg>("SELECT * FROM negotiations WHERE state NOT IN ('ACCEPTED','REJECTED','EXPIRED','CANCELLED') AND current_offer_id IS NOT NULL")) {
    const t = currentOffer(n).terms;
    if (t.validUntil && Date.parse(t.validUntil) <= Date.now()) { markExpired(n.id, "offer validity elapsed"); c++; }
  }
  return c;
}
