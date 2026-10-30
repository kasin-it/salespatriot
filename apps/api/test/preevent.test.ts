import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, fixtureCompany, fixtureUser } from "./helpers.ts";
import { buyerIntro, buyerReply2, publicKnowledge, runPreEventConversation, saveProfile, supplierReply1, type Ctx, type SupplierProfile } from "../src/services/preevent.ts";

// FIXTURE profile: stands in for facts a demo operator would type in. Test-only.
const profile: SupplierProfile = { company_id: 1, event_id: 1, own_company: 0, focus: "autonomous counter-drone interceptors", stand: "Hall 7, stand 7-123", days_present: "Mar 1–2",
  attendees: [{ name: "Alex Test", role: "CEO" }], bringing: ["one interceptor prototype"], shareable: ["interceptor drone, TRL 6"], gated: [{ topic: "technical specification", how: "NDA, on site" }, { topic: "pricing", how: "on site only" }], meeting_slots: ["Mar 1, 14:00"] };
const ctx: Ctx = { buyer: "Buyer Test Co", supplier: "Startup Test Ltd", event: "Test Expo", dates: "2027-03-01 – 2027-03-03", product: "counter-drone interceptors", quantity: 20, deadline: "2027-06-30", startup: true, known: ["Country: PL"], deliveryLocation: "Warsaw" };

test("buyer intro asks the five questions and admits what is not public", () => {
  const m = buyerIntro(ctx);
  assert.match(m.text, /Who from your team will be on site/);
  assert.match(m.text, /startup suppliers/);
  assert.deepEqual(m.data.questions, ["attendees", "stand", "showing", "shareable_now", "meeting_slot"]);
});

test("supplier agent answers only from the profile; gated topics are 'on site only'; banner marks it simulated", () => {
  const r = supplierReply1(profile, ctx, ["attendees", "stand", "showing", "shareable_now", "meeting_slot"]);
  assert.match(r.text, /SANDBOX — simulated supplier agent/);
  assert.ok(!/SANDBOX/.test(supplierReply1({ ...profile, own_company: 1 }, ctx, ["stand"]).text), "the operator's own company needs no simulated-agent banner");
  assert.ok(!/o\.\.\./.test(buyerIntro({ ...ctx, buyer: "Foo Sp. z o.o." }).text), "no double period after company names");
  assert.match(r.text, /Alex Test \(CEO\)/);
  assert.match(r.text, /technical specification \(NDA, on site\)/);
  assert.deepEqual(r.data.gated, ["technical specification", "pricing"]);
  const empty = supplierReply1({ ...profile, attendees: [], bringing: [], stand: null, meeting_slots: [], shareable: [], gated: [] }, ctx, ["attendees", "stand", "showing", "shareable_now", "meeting_slot"]);
  assert.equal((empty.text.match(/Not stated|Nothing is shareable/g) ?? []).length >= 4, true, "missing facts are 'not stated', never filled in");
  assert.ok(!/price|€|EUR/i.test(empty.text.split("To prepare")[0]!.replace(/Before the event vs\. on site only/, "")), "no price is invented");
});

test("buyer does not invent requirements it cannot back up", () => {
  const r = buyerReply2(ctx, ["quantity_delivery", "delivery_location", "requirements"], ["Mar 1, 14:00"], ["pricing"]);
  assert.match(r.text, /Quantity: 20/);
  assert.match(r.text, /not defined yet/);
  assert.equal(r.data.slot, "Mar 1, 14:00");
});

test("conversation: five turns, alternating, persisted as mission steps (no mailbox configured)", async () => {
  const db = freshDb();
  delete process.env.MAILPIT_URL; process.env.PREEVENT_PACE_MS = "0";
  const co = fixtureCompany(db, "Startup Test Ltd");
  const mid = db.insert("missions", { company_id: co, kind: "PREEVENT", prompt: "x", status: "RUNNING" });
  saveProfile(co, { event_id: null, own_company: 0, focus: profile.focus, stand: profile.stand, days_present: profile.days_present, attendees: profile.attendees, bringing: profile.bringing, shareable: profile.shareable, gated: profile.gated, meeting_slots: profile.meeting_slots }, fixtureUser(db, "op@t.example"));
  const turns = await runPreEventConversation(mid, ctx, profile);
  assert.deepEqual(turns.map((t) => t.from), ["buyer", "supplier", "buyer", "supplier", "buyer"]);
  assert.ok(turns.every((t) => !t.emailed), "nothing is claimed as emailed when no transport exists");
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM mission_steps WHERE mission_id=? AND kind='mail'", mid)!.c, 5);
  assert.match(turns[4]!.text, /Agreed: Mar 1, 14:00/);
});

test("public knowledge lists what is unknown (gated case)", () => {
  const db = freshDb();
  const co = db.insert("companies", { canonical_name: "Thin Co", normalized_name: "thin", country: "PL", origin: "TEST_FIXTURE" });
  const k = publicKnowledge(co);
  assert.equal(k.thin, true);
  assert.ok(k.unknown.includes("Products and specifications") && k.unknown.includes("Who will attend the event"));
});
