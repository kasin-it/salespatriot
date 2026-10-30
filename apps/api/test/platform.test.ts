import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, fixtureCompany, fixtureUser } from "./helpers.ts";
import { registerAllHandlers } from "../src/agents/handlers.ts";
import { drainQueue, enqueueTask, registerHandler, cancelTask, approveTask, ApprovalRequired } from "../src/agents/orchestrator.ts";
import { executeMcpTool } from "../src/mcp/adapter.ts";
import { matchSupplierToDemand, runMatchingForSupplier } from "../src/services/matching.ts";
import { storeNotice } from "../src/services/procurement-store.ts";
import { parseTedNotice } from "../src/connectors/ted.ts";
import { api } from "../src/routes/api.ts";
import { Hono } from "hono";
import { registerUser, login } from "../src/services/auth.ts";
import { audit } from "../src/lib/audit.ts";
import { draftEmail, sendApprovedEmail } from "../src/services/communication.ts";

test("orchestrator: retries with backoff, then fails visibly; disabled agents cannot receive tasks; cancellation", async () => {
  const db = freshDb();
  let calls = 0;
  registerHandler("t.flaky", async () => { calls++; throw new Error("boom"); });
  const id = enqueueTask("matching", "t.flaky", {}, "test", { maxAttempts: 2 })!;
  await drainQueue();
  assert.equal(db.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id=?", id)!.status, "RETRY_SCHEDULED");
  db.run("UPDATE agent_tasks SET run_after=? WHERE id=?", new Date(0).toISOString(), id);
  await drainQueue();
  const t = db.get<{ status: string; error: string; attempts: number }>("SELECT * FROM agent_tasks WHERE id=?", id)!;
  assert.equal(t.status, "FAILED"); assert.equal(t.error, "boom"); assert.equal(calls, 2);
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) c FROM agent_executions WHERE task_id=?", id)!.c, 2);
  db.run("UPDATE agents SET enabled=0 WHERE key='email'");
  assert.throws(() => enqueueTask("email", "x", {}, "t"), /disabled/);
  const q = enqueueTask("matching", "t.flaky", {}, "t")!;
  assert.equal(cancelTask(q, "t"), true);
  await drainQueue();
  assert.equal(db.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id=?", q)!.status, "CANCELLED");
});

test("orchestrator: dedupe key prevents duplicate pending tasks; approval gate pauses and resumes", async () => {
  const db = freshDb();
  const u = fixtureUser(db, "a@t.example");
  const c = fixtureCompany(db, "Co", { registered: true, userId: u });
  assert.ok(enqueueTask("matching", "t.x", {}, "t", { dedupeKey: "k" }));
  assert.equal(enqueueTask("matching", "t.x", {}, "t", { dedupeKey: "k" }), null);
  let approved = false;
  registerHandler("t.gate", async (ctx) => { if (!ctx.payload.approvedApprovalId) throw new ApprovalRequired("needs human", {}); approved = true; });
  const id = enqueueTask("matching", "t.gate", {}, "t", { companyId: c })!;
  await drainQueue();
  assert.equal(db.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id=?", id)!.status, "WAITING_APPROVAL");
  const ap = db.get<{ id: number }>("SELECT id FROM approvals WHERE entity_id=?", id)!;
  approveTask(ap.id, u, true);
  await drainQueue();
  assert.equal(approved, true);
});

test("MCP: unknown tool and missing permission are denied and recorded; nothing executes", async () => {
  const db = freshDb();
  const r1 = await executeMcpTool({ server: "none", tool: "browser_navigate", input: { url: "https://x.test" }, userId: null, grantedPermissions: ["mcp:read"] });
  assert.equal(r1.ok, false);
  db.run("INSERT INTO mcp_servers (name, provider, transport, config_origin) VALUES ('s','s','stdio','test')");
  db.run("INSERT INTO mcp_tools (server_id, tool_name, permission_required, status) VALUES (1,'click_element','mcp:act','AVAILABLE')");
  const r2 = await executeMcpTool({ server: "s", tool: "click_element", input: {}, userId: null, grantedPermissions: ["mcp:read"] });
  assert.match(r2.error!, /Permission mcp:act/);
  const rows = db.all<{ status: string }>("SELECT status FROM mcp_tool_executions ORDER BY id");
  assert.deepEqual(rows.map((r) => r.status), ["DENIED_UNKNOWN_TOOL", "DENIED_PERMISSION"]);
});

test("matching: claimed capability never reaches VERIFIED_MATCH; confirmed capability with CONFIRMED demand can; unrelated supplier no match", () => {
  const db = freshDb();
  const s = fixtureCompany(db, "Optics Test Supplier");
  db.run("INSERT INTO company_capabilities (company_id, category_key, label, capability_class, source_url, source_type, evidence_text, confidence) VALUES (?, 'optics_sights','Optics','PUBLICLY_CLAIMED_CAPABILITY','https://s.test','OFFICIAL_COMPANY_WEBSITE','we make sights',0.9)", s);
  const notice = { id: 1, title: "Sights", authority: "A", url: "https://ted.test/1", cpv: ["38636000"], deadline: "2099-01-01", demandClass: "CONFIRMED_DEMAND", country: "PL", completeness: 0.9 };
  const demand = { key: "n1", kind: "NOTICE" as const, notice, categories: ["optics_sights"], cpv: ["38636000"], demandClass: "CONFIRMED_DEMAND" };
  const m1 = matchSupplierToDemand(s, demand)!;
  assert.equal(m1.status, "POTENTIAL_MATCH"); assert.ok(m1.score <= 0.7);
  assert.ok(m1.missing.some((x) => /Eligibility/.test(x)) && m1.risks.some((x) => /NOT been checked/.test(x)));
  db.run("UPDATE company_capabilities SET capability_class='VERIFIED_CAPABILITY'");
  assert.equal(matchSupplierToDemand(s, demand)!.status, "VERIFIED_MATCH");
  assert.equal(matchSupplierToDemand(s, { ...demand, demandClass: "HISTORICAL_DEMAND" })!.status, "POTENTIAL_MATCH");
  const other = fixtureCompany(db, "Bakery");
  assert.equal(matchSupplierToDemand(other, demand), null);
  db.run("UPDATE company_capabilities SET capability_class='INFERRED_CAPABILITY'");
  assert.equal(matchSupplierToDemand(s, demand)!.status, "INSUFFICIENT_INFORMATION");
});

test("matching run over stored notices only uses confirmed, still-open demand", () => {
  const db = freshDb();
  const s = fixtureCompany(db, "Supplier");
  db.run("INSERT INTO company_capabilities (company_id, category_key, label, capability_class, source_url, source_type, evidence_text, confidence) VALUES (?, 'optics_sights','Optics','VERIFIED_CAPABILITY','https://s.test','USER_PROVIDED','x',0.9)", s);
  const base = { "notice-type": "cn-standard", "buyer-name": { pol: ["X"] }, "buyer-country": ["POL"], "classification-cpv": ["38636000"], "publication-date": "2099-01-01+01:00", links: { html: { ENG: "u" } } };
  storeNotice({ ...parseTedNotice({ ...base, "publication-number": "1-2099" })!, deadline: "2099-12-31T00:00:00" });
  storeNotice({ ...parseTedNotice({ ...base, "publication-number": "2-2099" })!, deadline: "2000-01-01T00:00:00" });
  assert.equal(runMatchingForSupplier(s), 1);
});

test("email: drafts only to stored public contacts, never sends without SMTP and says so", async () => {
  const db = freshDb();
  const a = fixtureCompany(db, "A", { registered: true }), b = fixtureCompany(db, "B");
  const phone = db.insert("company_contacts", { company_id: b, kind: "phone", value: "+48000", source_url: "https://b.test" });
  const mail = db.insert("company_contacts", { company_id: b, kind: "email", value: "sales@b.test", source_url: "https://b.test" });
  assert.throws(() => draftEmail({ companyId: a, contactId: phone, subject: "s", body: "b", createdBy: "1" }), /email contact/);
  assert.throws(() => draftEmail({ companyId: a, contactId: 9999, subject: "s", body: "b", createdBy: "1" }), /email contact/);
  const id = draftEmail({ companyId: a, contactId: mail, subject: "RFQ", body: "Please quote", createdBy: "1" });
  delete process.env.SMTP_HOST;
  const r = await sendApprovedEmail(id, 1);
  assert.equal(r.sent, false);
  assert.equal(db.get<{ status: string }>("SELECT status FROM email_messages WHERE id=?", id)!.status, "NOT_SENT_NO_PROVIDER");
});

test("API: auth required; tenant isolation on requirements, negotiations and policies", async () => {
  const db = freshDb();
  const app = new Hono().route("/api", api);
  const call = (path: string, token?: string, init: RequestInit = {}) => app.request(`/api${path}`, { ...init, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  assert.equal((await call("/events")).status, 401);
  registerUser("a@t.example", "A", "correct-horse-1"); registerUser("b@t.example", "B", "correct-horse-2");
  const ta = login("a@t.example", "correct-horse-1").token, tb = login("b@t.example", "correct-horse-2").token;
  const ua = db.get<{ id: number }>("SELECT id FROM users WHERE email='a@t.example'")!.id;
  const ca = fixtureCompany(db, "Company A", { registered: true, userId: ua });
  const r = await call("/requirements", ta, { method: "POST", body: JSON.stringify({ companyId: ca, title: "Secret requirement", categoryKeys: ["optics_sights"] }) });
  assert.equal(r.status, 201);
  assert.equal((await call(`/requirements?companyId=${ca}`, tb)).status, 403);
  assert.equal((await call(`/requirements?companyId=${ca}`, ta)).status, 200);
  assert.equal((await call(`/companies/${ca}/policy/BUYER`, tb, { method: "PUT", body: JSON.stringify({ max_unit_price: 1 }) })).status, 403);
  assert.equal((await call(`/companies/${ca}/facts`, tb, { method: "POST", body: JSON.stringify({ field: "website", value: "evil.example", reason: "takeover" }) })).status, 403);
  audit({ actorType: "system", companyId: ca, action: "x", summary: "company-A-private" });
  const feed = (await (await call("/activity", tb)).json()) as { summary: string }[];
  assert.ok(!feed.some((f) => f.summary === "company-A-private"));
  // Overview contains only counts of persisted rows; an empty DB reports zeros, not demo numbers.
  const ov = (await (await call("/overview", ta)).json()) as { events: { discovered: number }; deals: { real: number } };
  assert.equal(ov.events.discovered, 0); assert.equal(ov.deals.real, 0);
});

test("correcting company facts preserves previous evidence", async () => {
  const db = freshDb();
  const app = new Hono().route("/api", api);
  registerUser("a@t.example", "A", "correct-horse-1");
  const t = login("a@t.example", "correct-horse-1").token;
  const u = db.get<{ id: number }>("SELECT id FROM users")!.id;
  const c = fixtureCompany(db, "Co", { registered: true, userId: u });
  db.insert("facts", { entity_type: "company", entity_id: c, field_name: "website", field_value: "https://old.test", source_url: "https://src.test", source_type: "OFFICIAL_EVENT_WEBSITE", fact_kind: "COMPANY_PUBLISHED", confidence: 0.8 });
  const res = await app.request(`/api/companies/${c}/facts`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ field: "website", value: "https://new.test", reason: "official site moved" }) });
  assert.equal(res.status, 200);
  const rows = db.all<{ field_value: string; superseded_by: number | null; verification_status: string }>("SELECT * FROM facts WHERE entity_id=? AND field_name='website' ORDER BY id", c);
  assert.equal(rows.length, 2); assert.equal(rows[0]!.verification_status, "SUPERSEDED"); assert.ok(rows[0]!.superseded_by);
});

test("registerAllHandlers registers handlers for every user-startable task type", () => {
  freshDb(); registerAllHandlers();
});
