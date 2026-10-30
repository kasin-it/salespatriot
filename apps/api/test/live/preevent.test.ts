import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, fixtureCompany } from "../helpers.ts";
import { runPreEventConversation, type Ctx, type SupplierProfile } from "../../src/services/preevent.ts";

const live = process.env.LIVE === "1";
test("LIVE Mailpit: pre-event conversation travels as real emails and is read back", { skip: !live, timeout: 60_000 }, async () => {
  const base = process.env.MAILPIT_URL ?? "http://localhost:8026";
  await fetch(`${base}/api/v1/messages`, { method: "DELETE" });
  Object.assign(process.env, { SMTP_HOST: "127.0.0.1", SMTP_PORT: "1026", SMTP_FROM: "agent@arsenal.test", MAILPIT_URL: base, PREEVENT_PACE_MS: "0" });
  const db = freshDb();
  const co = fixtureCompany(db, "Startup Test Ltd");
  const mid = db.insert("missions", { company_id: co, kind: "PREEVENT", prompt: "x", status: "RUNNING" });
  // FIXTURE profile (test only)
  const profile: SupplierProfile = { company_id: co, event_id: 1, own_company: 0, focus: "counter-drone interceptors", stand: "7-123", days_present: "Mar 1", attendees: [{ name: "Alex Test", role: "CEO" }], bringing: ["prototype"], shareable: ["TRL 6"], gated: [{ topic: "pricing", how: "on site" }], meeting_slots: ["Mar 1, 14:00"] };
  const ctx: Ctx = { buyer: "Buyer Test Co", supplier: "Startup Test Ltd", event: "Test Expo", dates: null, product: "interceptors", quantity: 5, deadline: null, startup: true, known: [], deliveryLocation: null };
  const turns = await runPreEventConversation(mid, ctx, profile);
  assert.ok(turns.every((t) => t.emailed && t.readBack), JSON.stringify(turns.map((t) => [t.emailed, t.readBack])));
  const list = (await (await fetch(`${base}/api/v1/messages?limit=20`)).json()) as { messages: { Subject: string; From: { Address: string } }[] };
  const mine = list.messages.filter((m) => m.Subject.includes(`[PRE-${mid}-`));
  assert.equal(mine.length, 5);
  assert.deepEqual(new Set(mine.map((m) => m.From.Address)), new Set(["buyer-agent@arsenal.test", "supplier-agent@arsenal.test"]));
});
