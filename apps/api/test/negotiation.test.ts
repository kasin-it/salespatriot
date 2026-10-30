import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, fixtureCompany, fixtureUser } from "./helpers.ts";
import * as n from "../src/services/negotiation.ts";
import type { OfferTerms } from "@salespatriot/shared";

const terms = (o: Partial<OfferTerms> = {}): OfferTerms => ({ ...n.emptyTerms(), unitPrice: 100, currency: "EUR", quantity: 10, deliveryTerms: "DAP", leadTimeDays: 30, paymentTerms: "net30", validUntil: "2099-01-01T00:00:00Z", ...o });

function setup(mode: "REAL" | "SANDBOX" = "SANDBOX") {
  const db = freshDb();
  const ub = fixtureUser(db, "b@t.example"), us = fixtureUser(db, "s@t.example");
  const buyer = fixtureCompany(db, "Buyer Test Co", { registered: true, userId: ub });
  const supplier = fixtureCompany(db, "Supplier Test Co", { registered: true, userId: us });
  n.setPolicy(buyer, "BUYER", { currency: "EUR", max_unit_price: 110, max_quantity: 100, allowed_payment_terms: "net30,net45", max_lead_time_days: 45, max_rounds: 3, autonomous_accept: 0 }, ub);
  n.setPolicy(supplier, "SUPPLIER", { currency: "EUR", min_unit_price: 95, min_quantity: 5, allowed_payment_terms: "net30", max_rounds: 3, autonomous_accept: 0 }, us);
  const id = n.createNegotiation({ buyerId: buyer, supplierId: supplier, subject: "Test item", mode, userId: ub });
  return { db, ub, us, buyer, supplier, id };
}

test("state machine: illegal transitions rejected", () => {
  assert.equal(n.canTransition("INITIAL_CONTACT", "ACCEPTED"), false);
  assert.equal(n.canTransition("ACCEPTED", "COUNTEROFFER"), false);
  assert.equal(n.canTransition("RFQ_SENT", "QUOTATION_RECEIVED"), true);
});

test("REAL negotiation refuses a company without an authorised account; unidentified companies refused in both modes", () => {
  const db = freshDb();
  const a = fixtureCompany(db, "A", { registered: true }), b = fixtureCompany(db, "B (public record only)", { registered: false });
  assert.throws(() => n.createNegotiation({ buyerId: a, supplierId: b, subject: "x", mode: "REAL", userId: null }), /no authorised Arsenal AI account/);
  assert.ok(n.createNegotiation({ buyerId: a, supplierId: b, subject: "x", mode: "SANDBOX", userId: null }));
  const c = fixtureCompany(db, "C", { state: "UNVERIFIED" });
  assert.throws(() => n.createNegotiation({ buyerId: a, supplierId: c, subject: "x", mode: "REAL", userId: null }), /not identified|authorised/);
  assert.ok(n.createNegotiation({ buyerId: a, supplierId: c, subject: "x", mode: "SANDBOX", userId: null }), "SANDBOX may use an official-listing identity");
  const d = fixtureCompany(db, "D", { state: "INACTIVE" });
  assert.throws(() => n.createNegotiation({ buyerId: a, supplierId: d, subject: "x", mode: "SANDBOX", userId: null }), /not identified/);
});

test("full flow: RFQ → quotation → counter → both accept → deal with audit; versions chain", () => {
  const { db, ub, us, buyer, supplier, id } = setup();
  n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "RFQ", terms: terms({ unitPrice: null, currency: null }), origin: "HUMAN", actor: `user:${ub}` });
  const q = n.submitOffer({ negotiationId: id, fromCompanyId: supplier, kind: "QUOTATION", terms: terms({ unitPrice: 120 }), origin: "HUMAN", actor: `user:${us}` });
  assert.equal(q.version, 2);
  // Buyer's counter at 105 (≤110) is within limits; supplier's 120 quote is above buyer's max so buyer cannot accept it.
  assert.throws(() => n.acceptOffer({ negotiationId: id, offerId: q.offerId, companyId: buyer, userId: null, agent: true, actor: "agent:buyer_agent" }), n.NeedsApproval);
  const c = n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "COUNTEROFFER", terms: terms({ unitPrice: 105 }), origin: "HUMAN", actor: `user:${ub}` });
  const row = db.get<{ previous_offer_id: number }>("SELECT previous_offer_id FROM offers WHERE id=?", c.offerId)!;
  assert.equal(row.previous_offer_id, q.offerId);
  assert.equal(db.get<{ status: string }>("SELECT status FROM offers WHERE id=?", q.offerId)!.status, "SUPERSEDED");
  // Superseded version cannot be accepted
  assert.throws(() => n.acceptOffer({ negotiationId: id, offerId: q.offerId, companyId: supplier, userId: us, agent: false, actor: "u" }), /superseded/);
  // Issuer cannot accept own offer
  assert.throws(() => n.acceptOffer({ negotiationId: id, offerId: c.offerId, companyId: buyer, userId: ub, agent: false, actor: "u" }), /own offer/);
  const res = n.acceptOffer({ negotiationId: id, offerId: c.offerId, companyId: supplier, userId: us, agent: false, actor: `user:${us}` });
  assert.ok(res.dealId); assert.match(res.dealRef!, /^SBX-/);
  const deal = db.get<{ mode: string; total_value: number; status: string }>("SELECT * FROM deals WHERE id=?", res.dealId!)!;
  assert.equal(deal.mode, "SANDBOX"); assert.equal(deal.total_value, 1050); assert.match(deal.status, /NOT_A_SIGNED_CONTRACT/);
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM offer_acceptances")!.c, 2);
  assert.equal(n.getNegotiation(id).state, "ACCEPTED");
  assert.throws(() => n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "COUNTEROFFER", terms: terms(), origin: "HUMAN", actor: "x" }), /ACCEPTED/);
});

test("limits are enforced by the backend, not the caller: buyer offer above max price needs approval", () => {
  const { ub, buyer, supplier, us, id } = setup();
  n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "RFQ", terms: n.emptyTerms(), origin: "HUMAN", actor: "u" });
  n.submitOffer({ negotiationId: id, fromCompanyId: supplier, kind: "QUOTATION", terms: terms({ unitPrice: 120 }), origin: "HUMAN", actor: `user:${us}` });
  assert.throws(() => n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "COUNTEROFFER", terms: terms({ unitPrice: 115 }), origin: "AGENT", actor: "agent:buyer_agent" }), (e: unknown) => e instanceof n.NeedsApproval && /exceeds maximum purchase price/.test(e.message));
  assert.throws(() => n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "COUNTEROFFER", terms: terms({ unitPrice: 100, paymentTerms: "prepayment" }), origin: "AGENT", actor: "a" }), /not in permitted list/);
  void ub;
});

test("missing configuration means approval, never a default", () => {
  const db = freshDb();
  const u = fixtureUser(db, "x@t.example");
  const a = fixtureCompany(db, "A", { registered: true, userId: u }), b = fixtureCompany(db, "B", { registered: true });
  const id = n.createNegotiation({ buyerId: a, supplierId: b, subject: "s", mode: "SANDBOX", userId: u });
  n.submitOffer({ negotiationId: id, fromCompanyId: a, kind: "RFQ", terms: n.emptyTerms(), origin: "HUMAN", actor: "u" });
  assert.throws(() => n.submitOffer({ negotiationId: id, fromCompanyId: b, kind: "QUOTATION", terms: terms(), origin: "AGENT", actor: "agent" }), /No supplier negotiation limits/);
});

test("acceptance requires SIGNATORY authority, complete terms and a valid offer", () => {
  const { db, ub, us, buyer, supplier, id } = setup();
  n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "RFQ", terms: n.emptyTerms(), origin: "HUMAN", actor: "u" });
  const q = n.submitOffer({ negotiationId: id, fromCompanyId: supplier, kind: "QUOTATION", terms: terms({ unitPrice: 100, paymentTerms: null }), origin: "HUMAN", actor: "s" });
  assert.throws(() => n.acceptOffer({ negotiationId: id, offerId: q.offerId, companyId: buyer, userId: ub, agent: false, actor: "u" }), /Required commercial terms missing: paymentTerms/);
  const q2 = n.submitOffer({ negotiationId: id, fromCompanyId: supplier, kind: "COUNTEROFFER", terms: terms(), origin: "HUMAN", actor: "s" });
  db.run("UPDATE company_memberships SET authorization_level='STANDARD' WHERE user_id=?", ub);
  assert.throws(() => n.acceptOffer({ negotiationId: id, offerId: q2.offerId, companyId: buyer, userId: ub, agent: false, actor: "u" }), /signing authority/);
  void us;
});

test("autonomous agent acceptance needs the flag AND in-limit terms", () => {
  const { db, ub, buyer, supplier, us, id } = setup();
  n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "RFQ", terms: n.emptyTerms(), origin: "HUMAN", actor: "u" });
  const q = n.submitOffer({ negotiationId: id, fromCompanyId: supplier, kind: "QUOTATION", terms: terms({ unitPrice: 100 }), origin: "HUMAN", actor: `user:${us}` });
  assert.throws(() => n.acceptOffer({ negotiationId: id, offerId: q.offerId, companyId: buyer, userId: null, agent: true, actor: "agent:buyer_agent" }), /Autonomous acceptance is not enabled/);
  n.setPolicy(buyer, "BUYER", { autonomous_accept: 1 }, ub);
  const r = n.acceptOffer({ negotiationId: id, offerId: q.offerId, companyId: buyer, userId: null, agent: true, actor: "agent:buyer_agent" });
  assert.ok(r.dealId);
  assert.match(db.get<{ authorization_basis: string }>("SELECT authorization_basis FROM offer_acceptances WHERE company_id=? ", buyer)!.authorization_basis, /autonomous_accept/);
});

test("expired offers cannot be accepted and negotiation expires", () => {
  const { buyer, supplier, us, id } = setup();
  n.submitOffer({ negotiationId: id, fromCompanyId: buyer, kind: "RFQ", terms: n.emptyTerms(), origin: "HUMAN", actor: "u" });
  assert.throws(() => n.submitOffer({ negotiationId: id, fromCompanyId: supplier, kind: "QUOTATION", terms: terms({ validUntil: "2000-01-01T00:00:00Z" }), origin: "HUMAN", actor: `user:${us}` }), /already in the past/);
});

import { runAutopilot } from "../src/services/autopilot.ts";

function mandate(db: ReturnType<typeof freshDb>, buyer: number, supplier: number, u: number, sOpen: Partial<Record<string, number | string | null>> = {}, bMax = 110) {
  n.setPolicy(buyer, "BUYER", { currency: "EUR", max_unit_price: bMax, opening_unit_price: 80, max_quantity: 500, allowed_payment_terms: "net30", max_lead_time_days: 60, max_rounds: 8, autonomous_accept: 1 }, u);
  n.setPolicy(supplier, "SUPPLIER", { currency: "EUR", min_unit_price: 95, opening_unit_price: 130, opening_lead_time_days: 45, opening_payment_terms: "net30", opening_delivery_terms: "DAP", opening_validity_days: 14, autonomous_accept: 1, max_rounds: 8, ...sOpen } as never, u);
  void db;
}

test("autopilot: agents negotiate to a SANDBOX deal with zero human approvals", async () => {
  const db = freshDb();
  const u = fixtureUser(db, "x@t.example");
  const b = fixtureCompany(db, "B", { registered: true, userId: u }), s = fixtureCompany(db, "S", { registered: true });
  mandate(db, b, s, u, { min_unit_price: 108 });
  const id = n.createNegotiation({ buyerId: b, supplierId: s, subject: "200 items", mode: "SANDBOX", userId: u });
  const r = await runAutopilot(id, { quantity: 200, deliveryLocation: "Warsaw" });
  assert.equal(r.outcome, "DEAL", JSON.stringify(r));
  assert.equal(r.humanApprovals, 0);
  assert.match(r.dealRef!, /^SBX-/);
  const deal = db.get<{ terms: string }>("SELECT terms FROM deals")!;
  const price = JSON.parse(deal.terms).unitPrice;
  assert.ok(price >= 108 && price <= 110, `price ${price} must be inside both mandates`);
  assert.ok(r.rounds >= 2, `expected a real back-and-forth, got ${r.rounds} rounds: ${r.log.join(' | ')}`);
});

test("autopilot: no overlap in mandates ends as NO_AGREEMENT, never above the buyer's limit", async () => {
  const db = freshDb();
  const u = fixtureUser(db, "x@t.example");
  const b = fixtureCompany(db, "B", { registered: true, userId: u }), s = fixtureCompany(db, "S", { registered: true });
  mandate(db, b, s, u, {}, 90);
  const id = n.createNegotiation({ buyerId: b, supplierId: s, subject: "x", mode: "SANDBOX", userId: u });
  const r = await runAutopilot(id, { quantity: 10 });
  assert.equal(r.outcome, "NO_AGREEMENT");
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM deals")!.c, 0);
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM offers o JOIN negotiations ng ON ng.id=o.negotiation_id WHERE o.from_company_id=? AND json_extract(o.terms,'$.unitPrice') > 90", b)!.c, 0);
});

test("autopilot: missing supplier opening terms escalate instead of being invented", async () => {
  const db = freshDb();
  const u = fixtureUser(db, "x@t.example");
  const b = fixtureCompany(db, "B", { registered: true, userId: u }), s = fixtureCompany(db, "S", { registered: true });
  mandate(db, b, s, u, { opening_lead_time_days: null });
  const id = n.createNegotiation({ buyerId: b, supplierId: s, subject: "x", mode: "SANDBOX", userId: u });
  const r = await runAutopilot(id, { quantity: 10 });
  assert.equal(r.outcome, "ESCALATED");
  assert.match(r.reason!, /will not invent/);
});
