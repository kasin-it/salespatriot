import { test } from "node:test";
import assert from "node:assert/strict";
import nodemailer from "nodemailer";
import { freshDb, fixtureCompany, fixtureUser } from "../helpers.ts";
import { addFieldRep, sendFieldRequest, setVisionTransport } from "../../src/services/field.ts";
import { registerAllHandlers } from "../../src/agents/handlers.ts";
import { drainQueue, enqueueTask } from "../../src/agents/orchestrator.ts";
import * as n from "../../src/services/negotiation.ts";

const live = process.env.LIVE === "1";

test("LIVE chain: agent asks human → photo+spec reply → briefing → SANDBOX autopilot → DEAL with 0 human approvals", { skip: !live, timeout: 60_000 }, async () => {
  const base = process.env.MAILPIT_URL ?? "http://localhost:8026"; // dedicated Mailpit; this test clears it
  await fetch(`${base}/api/v1/messages`, { method: "DELETE" });
  Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_FROM: "agent@arsenal.test", MAILPIT_URL: base, OPENAI_API_KEY: "fixture-key" });
  // FIXTURE vision transport: stands in for the OpenAI API; what it "sees" is the photo's transcription below.
  const seen = ["TI-640 thermal imaging camera", "Price 1150 EUR", "Delivery 5 weeks", "ISO 9001 certified"];
  setVisionTransport(async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify({ readable: true, visible_text: seen, product_name: "TI-640 thermal imaging camera", unit_price: "1150 EUR", lead_time: "5 weeks", certifications: ["ISO 9001"], specs: [] }) } }] } }] }) }));
  const db = freshDb(); registerAllHandlers();
  const u = fixtureUser(db, "u@t.example");
  const buyer = fixtureCompany(db, "Our Buyer Co", { registered: true, userId: u });
  const vendor = fixtureCompany(db, "Public Thermal Vendor (public record)");
  n.setPolicy(buyer, "BUYER", { currency: "EUR", max_unit_price: 1300, opening_unit_price: 1000, max_quantity: 500, allowed_payment_terms: "net30", max_lead_time_days: 60, max_rounds: 8, autonomous_accept: 1 }, u);
  db.insert("negotiation_policies", { company_id: vendor, side: "SUPPLIER", simulated: 1, autonomous_accept: 1, currency: "EUR", min_unit_price: 1200, opening_unit_price: 1500, opening_lead_time_days: 42, opening_payment_terms: "net30", opening_delivery_terms: "DAP", opening_validity_days: 14, max_rounds: 8 });
  const repId = addFieldRep(buyer, "Marek", "marek@field.test", u);
  const reqId = await sendFieldRequest({ companyId: buyer, repId, targetCompanyId: vendor, standHint: "A12", userId: u, autoNegotiate: true, rfqTerms: { quantity: 200, deliveryLocation: "Warsaw" } });
  const token = db.get<{ token: string }>("SELECT token FROM field_requests WHERE id=?", reqId)!.token;

  // The ONLY human action: reply with a photo and a spec text.
  const t = nodemailer.createTransport({ host: "127.0.0.1", port: 1026, secure: false });
  await t.sendMail({ from: "marek@field.test", to: "agent@arsenal.test", subject: `Re: ${token}`, text: "Jestem przy stoisku.", attachments: [{ filename: "flyer.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2]), contentType: "image/png" }, { filename: "spec.txt", content: "TI-640 thermal imaging camera, night vision. Payment terms: net30", contentType: "text/plain" }] });
  await new Promise((r) => setTimeout(r, 500));

  enqueueTask("email", "field.poll", {}, "test");
  await drainQueue();

  const att = db.all<{ filename: string; extraction_status: string }>("SELECT filename, extraction_status FROM email_attachments ORDER BY filename");
  assert.deepEqual(att.map((a) => a.extraction_status), ["EXTRACTED_VISION", "EXTRACTED_TEXT"]);
  const fr = db.get<{ status: string; briefing: string; negotiation_id: number; summary: string }>("SELECT * FROM field_requests WHERE id=?", reqId)!;
  assert.equal(fr.status, "REPLIED");
  assert.equal(JSON.parse(fr.summary).terms.unitPrice, 1150);
  const b = JSON.parse(fr.briefing);
  assert.match(b.fit.priceVsMandate, /within mandate/);
  assert.match(b.negotiation.decision, /SANDBOX autopilot started/);
  const deal = db.get<{ mode: string; deal_ref: string; terms: string }>("SELECT * FROM deals WHERE negotiation_id=?", fr.negotiation_id)!;
  assert.equal(deal.mode, "SANDBOX");
  const price = JSON.parse(deal.terms).unitPrice;
  assert.ok(price >= 1200 && price <= 1300, `price ${price} must be inside both mandates`);
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM approvals WHERE decided_by_user_id IS NOT NULL")!.c, 0);
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM approvals")!.c, 0, "no approval was even requested");
  setVisionTransport(undefined);
});

test("a simulated mandate can never be used in a REAL negotiation", () => {
  const db = freshDb();
  const a = fixtureCompany(db, "A", { registered: true }), b = fixtureCompany(db, "B", { registered: true });
  db.insert("negotiation_policies", { company_id: b, side: "SUPPLIER", simulated: 1 });
  assert.throws(() => n.createNegotiation({ buyerId: a, supplierId: b, subject: "x", mode: "REAL", userId: null }), /SANDBOX/);
});
