import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { freshDb, fixtureCompany } from "./helpers.ts";
import { api } from "../src/routes/api.ts";
import { logAgentEmail, missionFromSubject } from "../src/services/emaillog.ts";
import { registerUser, login } from "../src/services/auth.ts";

test("emails resolve to their mission by subject tag", () => {
  const db = freshDb();
  const co = fixtureCompany(db, "Buyer Test Co", { registered: true });
  const rep = db.insert("field_reps", { company_id: co, name: "Rep", email: "rep@t.example" });
  const mid = db.insert("missions", { company_id: co, kind: "FIELD", prompt: "x", status: "RUNNING" });
  const fr = db.insert("field_requests", { company_id: co, rep_id: rep, token: "ARS-TEST01", subject: "s", body: "b", mode: "SMTP", status: "REQUESTED", mission_id: mid });
  const neg = db.insert("negotiations", { mode: "SANDBOX", buyer_company_id: co, supplier_company_id: fixtureCompany(db, "S"), subject: "s", state: "INITIAL_CONTACT" });
  db.update("field_requests", fr, { negotiation_id: neg });
  assert.equal(missionFromSubject(`[PRE-${mid}-3] Re: hi`), mid);
  assert.equal(missionFromSubject("Jesteś na evencie? [ARS-TEST01]"), mid);
  assert.equal(missionFromSubject(`[NEG-${neg}-v2] QUOTATION: x`), mid);
  assert.equal(missionFromSubject("unrelated"), null);
});

test("command center: empty state is zeros; counts come from stored rows only", async () => {
  const db = freshDb();
  const app = new Hono().route("/api", api);
  registerUser("a@t.example", "A", "correct-horse-1");
  const tok = login("a@t.example", "correct-horse-1").token;
  const u = db.get<{ id: number }>("SELECT id FROM users")!.id;
  const co = fixtureCompany(db, "Buyer Test Co", { registered: true, userId: u });
  const get = async () => (await (await app.request("/api/command-center", { headers: { authorization: `Bearer ${tok}` } })).json()) as { kpis: Record<string, unknown>; feed: unknown[]; missions: unknown[] };
  let d = await get();
  assert.equal(d.kpis.agentEmails, 0); assert.equal(d.kpis.dealsClosed, 0); assert.equal(d.kpis.humanApprovals, 0); assert.deepEqual(d.missions, []);
  const mid = db.insert("missions", { company_id: co, kind: "SOURCING", prompt: "x", status: "WAITING_REPLY" });
  logAgentEmail({ kind: "pre_event", from: "buyer-agent@arsenal.test", to: "supplier-agent@arsenal.test", subject: `[PRE-${mid}-1] Hello`, body: "hi" });
  d = await get();
  assert.equal(d.kpis.agentEmails, 1); assert.equal(d.missions.length, 1); assert.equal(d.feed.length, 1);
  db.run("UPDATE missions SET archived=1");
  d = await get();
  assert.equal(d.missions.length, 0, "archived missions are hidden");
  assert.equal(d.kpis.agentEmails, 0, "and so are their emails");
});

test("event preview refuses unknown products and field-events lists only events with missions", async () => {
  const db = freshDb();
  const app = new Hono().route("/api", api);
  registerUser("p@t.example", "P", "correct-horse-1");
  const tok = login("p@t.example", "correct-horse-1").token;
  const u = db.get<{ id: number }>("SELECT id FROM users")!.id;
  const co = fixtureCompany(db, "Buyer Test Co", { registered: true, userId: u });
  const call = (path: string, init?: RequestInit) => app.request(`/api${path}`, { ...init, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" } });
  const bad = await call("/events-preview", { method: "POST", body: JSON.stringify({ prompt: "Find me events with bakery equipment please" }) });
  assert.equal(bad.status, 422);
  assert.deepEqual(await (await call("/field-events")).json(), []);
  const ev = db.insert("events", { name: "Test Expo", official_url: "https://expo.test", discovered_via: "USER_URL" });
  const rep = db.insert("field_reps", { company_id: co, name: "Rep One", email: "rep@t.example" });
  const mid = db.insert("missions", { company_id: co, kind: "SOURCING", prompt: "x", status: "WAITING_REPLY", event_id: ev });
  db.insert("field_requests", { company_id: co, rep_id: rep, event_id: ev, token: "ARS-T1", subject: "s", body: "b", mode: "SMTP", status: "REQUESTED", mission_id: mid });
  db.update("missions", mid, { field_request_id: 1 });
  logAgentEmail({ kind: "field_request", from: "agent@arsenal.test", to: "rep@t.example", subject: "Jesteś na evencie? [ARS-T1]", body: "hello" });
  const list = (await (await call("/field-events")).json()) as { name: string; people: { name: string }[]; emails: number }[];
  assert.equal(list.length, 1); assert.equal(list[0]!.people[0]!.name, "Rep One"); assert.equal(list[0]!.emails, 1);
  const detail = (await (await call(`/field-events/${ev}`)).json()) as { people: unknown[]; log: { type: string }[] };
  assert.equal(detail.people.length, 1); assert.ok(detail.log.some((l) => l.type === "email"));
});
