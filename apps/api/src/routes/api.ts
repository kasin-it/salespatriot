import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import nodemailer from "nodemailer";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { AGENT_KEYS, type OfferTerms } from "@salespatriot/shared";
import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { errorMessage, now, normalizeCompanyName, normalizeUrl } from "../lib/util.ts";
import { recordFact, upsertSource } from "../lib/provenance.ts";
import { authenticate, createApiToken, login, registerUser, requireMember, userCompanyIds, type AuthUser } from "../services/auth.ts";
import { onboardCompany } from "../services/onboarding.ts";
import { addEvent, storeExhibitors, resolveExhibitor } from "../services/events.ts";
import { enableMonitoring } from "../services/monitoring.ts";
import { approveTask, cancelTask, enqueueTask } from "../agents/orchestrator.ts";
import { search } from "../services/search.ts";
import { indexCompany } from "../services/companies.ts";
import { runMatchingForSupplier } from "../services/matching.ts";
import * as neg from "../services/negotiation.ts";
import { draftEmail, parseTermsFromText, prepareCall, recordIncomingEmail, rfqEmailBody, sendApprovedEmail, smtpConfigured, twilioConfigured } from "../services/communication.ts";
import { discoverServer, executeMcpTool, loadMcpConfig, registry, syncConfiguredServers } from "../mcp/adapter.ts";
import { loadProfile, saveProfile } from "../services/preevent.ts";
import { addStep, getDemoConfig, putDemoConfig, rankEvents } from "../services/mission.ts";
import { visionConfigured, visionModel, visionProvider } from "../services/vision.ts";
import { simplePdf } from "../lib/pdf.ts";
import { addFieldRep, pollInbox, mailpitUrl } from "../services/field.ts";
import { runAutopilot } from "../services/autopilot.ts";
import { TED_FILTERS } from "../connectors/ted.ts";
import { CATEGORIES, categoriesForCpv } from "../lib/taxonomy.ts";

type Env = { Variables: { user: AuthUser } };
export const api = new Hono<Env>();

const db = () => getDb();
const page = (c: Context, def = 50) => {
  const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? def)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  return { limit, offset };
};

api.onError((e, c) => {
  const msg = errorMessage(e);
  const status = e instanceof z.ZodError ? 400 : msg.startsWith("Forbidden") ? 403 : e instanceof neg.NeedsApproval ? 409 : e instanceof neg.NegotiationError ? 422 : /not found/i.test(msg) ? 404 : 400;
  if (e instanceof neg.NeedsApproval) return c.json({ error: "APPROVAL_REQUIRED", reasons: e.reasons }, 409);
  if (e instanceof z.ZodError) return c.json({ error: "VALIDATION", issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
  return c.json({ error: msg }, status);
});

// ---- Auth -------------------------------------------------------------------------------
api.post("/auth/register", async (c) => {
  const b = z.object({ email: z.string(), name: z.string().min(1), password: z.string() }).parse(await c.req.json());
  registerUser(b.email, b.name, b.password);
  return c.json(login(b.email, b.password));
});
api.post("/auth/login", async (c) => {
  const b = z.object({ email: z.string(), password: z.string() }).parse(await c.req.json());
  try { return c.json(login(b.email, b.password)); } catch { return c.json({ error: "Invalid credentials" }, 401); }
});
api.get("/health", (c) => c.json({ ok: true, time: now() }));

api.use("*", async (c, next) => {
  const h = c.req.header("authorization");
  const user = authenticate(h?.startsWith("Bearer ") ? h.slice(7) : null);
  if (!user) return c.json({ error: "Unauthorized" }, 401);
  c.set("user", user);
  // API tokens carry scopes; 'write' is needed for mutating calls.
  if (user.scopes && c.req.method !== "GET" && !user.scopes.includes("write")) return c.json({ error: "Token lacks write scope" }, 403);
  await next();
});

const uid = (c: Context<Env>) => c.get("user").id;
const body = async <T extends z.ZodType>(c: Context<Env>, s: T): Promise<z.infer<T>> => s.parse(await c.req.json());

api.get("/me", (c) => {
  const u = c.get("user");
  const companies = db().all("SELECT c.id, c.canonical_name name, c.identity_state, m.role, m.authorization_level FROM company_memberships m JOIN companies c ON c.id=m.company_id WHERE m.user_id=?", u.id);
  return c.json({ user: u, companies });
});
api.post("/tokens", async (c) => {
  const b = await body(c, z.object({ label: z.string(), scopes: z.array(z.enum(["read", "write"])).min(1) }));
  return c.json({ token: createApiToken(uid(c), b.label, b.scopes), note: "Shown once. Store it securely." });
});

// ---- Overview & activity (all numbers are COUNT(*) over persisted rows) ----------------------
const count = (sql: string, ...p: (string | number)[]) => db().get<{ n: number }>(sql, ...p)?.n ?? 0;
api.get("/overview", (c) => {
  const t = (s: string) => count(`SELECT COUNT(*) n FROM ${s}`);
  return c.json({
    events: { discovered: t("events"), monitored: count("SELECT COUNT(*) n FROM event_monitoring_jobs WHERE enabled=1"), researched: count("SELECT COUNT(*) n FROM events WHERE research_status LIKE 'COMPLETED%'") },
    exhibitors: { total: count("SELECT COUNT(*) n FROM event_exhibitors WHERE removed_at IS NULL"), resolvedToCompany: count("SELECT COUNT(*) n FROM event_exhibitors WHERE company_id IS NOT NULL") },
    companies: { total: t("companies"), identified: count("SELECT COUNT(*) n FROM companies WHERE identity_state IN ('IDENTIFIED','VERIFIED')"), verified: count("SELECT COUNT(*) n FROM companies WHERE identity_state='VERIFIED'"), enriched: count("SELECT COUNT(*) n FROM companies WHERE enrichment_status='COMPLETED'"), registered: count("SELECT COUNT(*) n FROM companies WHERE is_registered=1") },
    procurement: { notices: t("procurement_notices"), confirmedDemand: count("SELECT COUNT(*) n FROM procurement_notices WHERE demand_class='CONFIRMED_DEMAND'") },
    marketplace: { buyerRequirements: t("buyer_requirements"), supplierOfferings: t("supplier_offerings"), matches: t("matches"), verifiedMatches: count("SELECT COUNT(*) n FROM matches WHERE status='VERIFIED_MATCH'") },
    negotiations: { active: count("SELECT COUNT(*) n FROM negotiations WHERE state NOT IN ('ACCEPTED','REJECTED','EXPIRED','CANCELLED')"), real: count("SELECT COUNT(*) n FROM negotiations WHERE mode='REAL'"), sandbox: count("SELECT COUNT(*) n FROM negotiations WHERE mode='SANDBOX'") },
    deals: { real: count("SELECT COUNT(*) n FROM deals WHERE mode='REAL'"), sandbox: count("SELECT COUNT(*) n FROM deals WHERE mode='SANDBOX'") },
    tasks: { queued: count("SELECT COUNT(*) n FROM agent_tasks WHERE status IN ('QUEUED','RETRY_SCHEDULED')"), running: count("SELECT COUNT(*) n FROM agent_tasks WHERE status='RUNNING'"), failed: count("SELECT COUNT(*) n FROM agent_tasks WHERE status='FAILED'"), waitingApproval: count("SELECT COUNT(*) n FROM agent_tasks WHERE status='WAITING_APPROVAL'"), succeeded: count("SELECT COUNT(*) n FROM agent_tasks WHERE status='SUCCEEDED'") },
    connectors: db().all("SELECT key, name, status, last_success_at, last_error FROM connector_status ORDER BY key"),
  });
});

api.get("/activity", (c) => {
  const { limit, offset } = page(c, 50);
  const mine = userCompanyIds(uid(c));
  const rows = db().all<{ company_id: number | null }>("SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?", limit * 3, offset);
  // Company-scoped entries are only visible to members of that company.
  return c.json(rows.filter((r) => r.company_id == null || mine.includes(r.company_id)).slice(0, limit));
});

api.get("/search", (c) => c.json(search(c.req.query("q") ?? "", c.req.query("types")?.split(",").filter(Boolean))));

// ---- Events ---------------------------------------------------------------------------------
api.get("/events", (c) => {
  const rows = db().all<{ id: number; start_date: string | null; end_date: string | null }>(`
    SELECT e.*, (SELECT COUNT(*) FROM event_exhibitors x WHERE x.event_id=e.id AND x.removed_at IS NULL) exhibitors,
      (SELECT COUNT(*) FROM event_exhibitors x JOIN companies co ON co.id=x.company_id WHERE x.event_id=e.id AND co.identity_state IN ('IDENTIFIED','VERIFIED')) identified_companies,
      (SELECT COUNT(*) FROM event_exhibitors x JOIN companies co ON co.id=x.company_id WHERE x.event_id=e.id AND co.identity_state='VERIFIED') verified_companies,
      (SELECT COUNT(*) FROM event_exhibitors x WHERE x.event_id=e.id AND x.resolution_status='PENDING_DETAIL') pending_profiles,
      (SELECT COUNT(*) FROM event_updates u WHERE u.event_id=e.id) updates,
      m.interval_minutes, m.enabled monitoring_enabled, m.last_checked_at, m.last_success_at, m.changes_detected, m.last_error monitoring_error
    FROM events e LEFT JOIN event_monitoring_jobs m ON m.event_id=e.id ORDER BY e.start_date DESC, e.id DESC`);
  const today = new Date().toISOString().slice(0, 10);
  return c.json(rows.map((r) => ({ ...r, phase: !r.start_date ? "UNKNOWN_DATES" : r.end_date && r.end_date < today ? "HISTORICAL" : r.start_date <= today ? "ONGOING" : "UPCOMING" })));
});
api.post("/events", async (c) => {
  const b = await body(c, z.object({ url: z.string().url() }));
  const e = addEvent({ url: b.url, userId: uid(c), discoveredVia: "USER_URL" });
  const taskId = enqueueTask("event_research", "event.research", { eventId: e.id }, `user:${uid(c)}`, { dedupeKey: `research:${e.id}`, entityType: "event", entityId: e.id, priority: 1 });
  return c.json({ ...e, taskId }, e.created ? 201 : 200);
});
api.post("/events/discover", (c) => c.json({ taskId: enqueueTask("event_discovery", "event.discover", {}, `user:${uid(c)}`, { dedupeKey: "discover" }) }));
api.get("/events/:id", (c) => {
  const id = Number(c.req.param("id"));
  const e = db().get<Record<string, unknown>>("SELECT * FROM events WHERE id=?", id);
  if (!e) return c.json({ error: "Event not found" }, 404);
  return c.json({
    event: { ...e, relevance_reasons: json(e.relevance_reasons, []) },
    categories: db().all("SELECT * FROM event_categories WHERE event_id=?", id),
    sources: db().all("SELECT s.*, es.role FROM event_sources es JOIN sources s ON s.id=es.source_id WHERE es.event_id=?", id),
    documents: db().all("SELECT * FROM event_documents WHERE event_id=?", id),
    updates: db().all("SELECT * FROM event_updates WHERE event_id=? ORDER BY id DESC LIMIT 100", id),
    monitoring: db().get("SELECT * FROM event_monitoring_jobs WHERE event_id=?", id) ?? null,
    tasks: db().all("SELECT id, agent_key, type, status, progress_note, error, attempts, started_at, finished_at, created_at FROM agent_tasks WHERE (entity_type='event' AND entity_id=?) ORDER BY id DESC LIMIT 30", id),
    snapshots: db().all("SELECT * FROM event_snapshots WHERE event_id=? ORDER BY id DESC LIMIT 20", id),
    stats: {
      exhibitors: count("SELECT COUNT(*) n FROM event_exhibitors WHERE event_id=? AND removed_at IS NULL", id),
      pendingProfiles: count("SELECT COUNT(*) n FROM event_exhibitors WHERE event_id=? AND resolution_status='PENDING_DETAIL'", id),
      companies: count("SELECT COUNT(DISTINCT company_id) n FROM event_exhibitors WHERE event_id=? AND company_id IS NOT NULL", id),
      withWebsite: count("SELECT COUNT(*) n FROM event_exhibitors WHERE event_id=? AND website IS NOT NULL", id),
      matches: count("SELECT COUNT(*) n FROM matches m WHERE m.supplier_company_id IN (SELECT company_id FROM event_exhibitors WHERE event_id=?)", id),
    },
  });
});
api.get("/events/:id/exhibitors", (c) => {
  const id = Number(c.req.param("id"));
  const { limit, offset } = page(c, 50);
  const q = c.req.query("q");
  const where = ["x.event_id=?"]; const p: (string | number)[] = [id];
  if (q) { where.push("x.exhibitor_name LIKE ?"); p.push(`%${q}%`); }
  if (c.req.query("status")) { where.push("x.resolution_status=?"); p.push(c.req.query("status")!); }
  const total = count(`SELECT COUNT(*) n FROM event_exhibitors x WHERE ${where.join(" AND ")}`, ...p);
  const rows = db().all(`SELECT x.*, co.identity_state, co.enrichment_status, co.website company_website FROM event_exhibitors x LEFT JOIN companies co ON co.id=x.company_id WHERE ${where.join(" AND ")} ORDER BY x.exhibitor_name LIMIT ? OFFSET ?`, ...p, limit, offset);
  return c.json({ total, rows });
});
api.post("/events/:id/research", (c) => {
  const id = Number(c.req.param("id"));
  const taskId = enqueueTask("event_research", "event.research", { eventId: id }, `user:${uid(c)}`, { dedupeKey: `research:${id}`, entityType: "event", entityId: id, priority: 1 });
  return c.json({ taskId, note: taskId ? "Research task queued" : "A research task for this event is already queued or running" });
});
api.post("/events/:id/monitoring", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await body(c, z.object({ intervalMinutes: z.number().int().min(15).max(10080), enabled: z.boolean().default(true) }));
  if (b.enabled) enableMonitoring(id, b.intervalMinutes); else db().run("UPDATE event_monitoring_jobs SET enabled=0 WHERE event_id=?", id);
  return c.json({ ok: true });
});
api.post("/events/:id/check-now", (c) => {
  const id = Number(c.req.param("id"));
  return c.json({ taskId: enqueueTask("event_monitoring", "event.monitor", { eventId: id }, `user:${uid(c)}`, { dedupeKey: `monitor:${id}`, entityType: "event", entityId: id }) });
});
// Results returned by an authorised MCP/browser session or a manual export. Persisted with provenance; the backend stays the source of truth.
api.post("/events/:id/exhibitors/import", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await body(c, z.object({
    collectionMethod: z.enum(["MCP_TOOL", "USER_EXPORT"]),
    sourceUrl: z.string().url(),
    exhibitors: z.array(z.object({ name: z.string().min(1), country: z.string().nullish(), website: z.string().nullish(), booth: z.string().nullish(), description: z.string().nullish(), evidence: z.string().min(3) })).min(1).max(5000),
  }));
  if (!db().get("SELECT id FROM events WHERE id=?", id)) return c.json({ error: "Event not found" }, 404);
  upsertSource(b.sourceUrl, b.collectionMethod === "MCP_TOOL" ? "MCP_TOOL" : "USER_PROVIDED");
  const res = storeExhibitors(id, b.exhibitors.map((x) => ({ externalId: null, name: x.name.trim(), stub: false, country: x.country ?? null, city: null, website: normalizeUrl(x.website), booth: x.booth ?? null, description: x.description ?? null, categories: [], profileUrl: null, sourceUrl: b.sourceUrl, evidence: `[${b.collectionMethod}] ${x.evidence}` })));
  for (const r of db().all<{ id: number }>("SELECT id FROM event_exhibitors WHERE event_id=? AND company_id IS NULL AND resolution_status='PENDING'", id)) resolveExhibitor(r.id);
  audit({ actorType: b.collectionMethod === "MCP_TOOL" ? "mcp" : "user", actorId: uid(c), action: "exhibitors.imported", entityType: "event", entityId: id, summary: `${res.added} exhibitors imported via ${b.collectionMethod} from ${b.sourceUrl}` });
  return c.json(res);
});

// ---- Companies ----------------------------------------------------------------------------------
api.get("/companies", (c) => {
  const { limit, offset } = page(c, 50);
  const q = c.req.query("q"); const where: string[] = []; const p: (string | number)[] = [];
  if (q) { where.push("(c.canonical_name LIKE ? OR c.website_domain LIKE ?)"); p.push(`%${q}%`, `%${q}%`); }
  if (c.req.query("state")) { where.push("c.identity_state=?"); p.push(c.req.query("state")!); }
  if (c.req.query("eventId")) { where.push("c.id IN (SELECT company_id FROM event_exhibitors WHERE event_id=?)"); p.push(Number(c.req.query("eventId"))); }
  if (c.req.query("category")) { where.push("c.id IN (SELECT company_id FROM company_capabilities WHERE category_key=?)"); p.push(c.req.query("category")!); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  return c.json({ total: count(`SELECT COUNT(*) n FROM companies c ${w}`, ...p), rows: db().all(`SELECT c.*, (SELECT COUNT(*) FROM event_exhibitors x WHERE x.company_id=c.id) events, (SELECT COUNT(*) FROM company_capabilities k WHERE k.company_id=c.id) capabilities FROM companies c ${w} ORDER BY c.canonical_name LIMIT ? OFFSET ?`, ...p, limit, offset) });
});
api.post("/companies", async (c) => {
  const b = await body(c, z.object({ legalName: z.string().min(2), website: z.string().optional(), country: z.string().length(2).optional(), registrationNumber: z.string().optional(), vat: z.string().optional(), lei: z.string().optional(), businessEmailDomain: z.string().optional(), jobTitle: z.string().optional(), authorizationLevel: z.enum(["SIGNATORY", "STANDARD", "READ_ONLY"]).optional() }));
  return c.json(onboardCompany({ ...b, userId: uid(c) }), 201);
});
api.get("/companies/:id", (c) => {
  const id = Number(c.req.param("id"));
  const co = db().get<Record<string, unknown>>("SELECT * FROM companies WHERE id=?", id);
  if (!co) return c.json({ error: "Company not found" }, 404);
  const facts = db().all<{ field_name: string; field_value: string | null; id: number; superseded_by: number | null }>("SELECT * FROM facts WHERE entity_type='company' AND entity_id=? ORDER BY field_name, collected_at DESC", id);
  const byField = new Map<string, Set<string | null>>();
  for (const f of facts.filter((x) => !x.superseded_by)) byField.set(f.field_name, (byField.get(f.field_name) ?? new Set()).add(f.field_value));
  const mine = userCompanyIds(uid(c));
  const isMember = mine.includes(id);
  return c.json({
    company: co, isMember,
    identifiers: db().all("SELECT * FROM company_identifiers WHERE company_id=?", id),
    aliases: db().all("SELECT * FROM company_aliases WHERE company_id=?", id),
    products: db().all("SELECT * FROM company_products WHERE company_id=? ORDER BY id LIMIT 200", id),
    capabilities: db().all("SELECT * FROM company_capabilities WHERE company_id=? ORDER BY capability_class, label", id),
    certifications: db().all("SELECT * FROM company_certifications WHERE company_id=?", id),
    contacts: db().all("SELECT * FROM company_contacts WHERE company_id=?", id),
    events: db().all("SELECT e.id, e.name, e.start_date, x.booth, x.profile_url, x.source_url, x.evidence_text FROM event_exhibitors x JOIN events e ON e.id=x.event_id WHERE x.company_id=?", id),
    procurementAwards: db().all("SELECT id, title, source_url, publication_date, contracting_authority FROM procurement_notices WHERE awarded_suppliers LIKE ? LIMIT 50", `%${String(co.canonical_name).replace(/[%_"]/g, "")}%`),
    facts, conflicts: [...byField.entries()].filter(([, v]) => v.size > 1).map(([field, v]) => ({ field, values: [...v] })),
    tasks: db().all("SELECT id, agent_key, type, status, error, created_at FROM agent_tasks WHERE entity_type='company' AND entity_id=? ORDER BY id DESC LIMIT 10", id),
  });
});
api.post("/companies/:id/verify", (c) => {
  const id = Number(c.req.param("id"));
  return c.json({ taskId: enqueueTask("company_identity", "company.identity", { companyId: id }, `user:${uid(c)}`, { dedupeKey: `identity:${id}`, entityType: "company", entityId: id, priority: 2 }) });
});
api.post("/companies/:id/enrich", (c) => {
  const id = Number(c.req.param("id"));
  return c.json({ taskId: enqueueTask("company_discovery", "company.enrich", { companyId: id }, `user:${uid(c)}`, { dedupeKey: `enrich:${id}`, entityType: "company", entityId: id, priority: 2 }) });
});
// Authorised members correct or confirm. Prior evidence is preserved: old facts are marked superseded, never deleted.
api.post("/companies/:id/facts", async (c) => {
  const id = Number(c.req.param("id"));
  requireMember(uid(c), id, "ADMIN");
  const b = await body(c, z.object({ field: z.enum(["website", "legal_name", "description", "country"]), value: z.string().min(1), reason: z.string().min(3) }));
  const newId = recordFact({ entityType: "company", entityId: id, field: b.field, value: b.value, sourceUrl: null, sourceType: "USER_PROVIDED", factKind: "USER_PROVIDED", evidence: `Provided by authorised company representative: ${b.reason}`, confidence: 1, verification: "VERIFIED", userId: uid(c) });
  db().run("UPDATE facts SET superseded_by=?, verification_status='SUPERSEDED' WHERE entity_type='company' AND entity_id=? AND field_name=? AND id != ? AND superseded_by IS NULL", newId, id, b.field, newId);
  const col = { website: "website", legal_name: "legal_name", description: "description", country: "country" }[b.field];
  const extra = b.field === "website" ? { website_domain: normalizeUrl(b.value) ? new URL(normalizeUrl(b.value)!).hostname.replace(/^www\./, "") : null, website: normalizeUrl(b.value) } : { [col]: b.value };
  db().update("companies", id, { ...extra, updated_at: now() } as Record<string, string | null>);
  indexCompany(id);
  audit({ actorType: "user", actorId: uid(c), companyId: id, action: "company.fact_corrected", entityType: "company", entityId: id, summary: `${b.field} set by company representative (previous evidence retained)` });
  return c.json({ factId: newId });
});
api.post("/companies/:id/confirm-capability", async (c) => {
  const id = Number(c.req.param("id"));
  requireMember(uid(c), id, "ADMIN");
  const b = await body(c, z.object({ capabilityId: z.number().int(), confirm: z.boolean() }));
  const cap = db().get<{ company_id: number; label: string }>("SELECT company_id, label FROM company_capabilities WHERE id=?", b.capabilityId);
  if (!cap || cap.company_id !== id) return c.json({ error: "Capability not found" }, 404);
  db().update("company_capabilities", b.capabilityId, b.confirm ? { capability_class: "VERIFIED_CAPABILITY", verification_status: "VERIFIED" } : { capability_class: "UNVERIFIED_CAPABILITY", verification_status: "REJECTED" });
  audit({ actorType: "user", actorId: uid(c), companyId: id, action: b.confirm ? "capability.confirmed" : "capability.rejected", entityType: "company", entityId: id, summary: `${cap.label}: ${b.confirm ? "confirmed" : "rejected"} by company` });
  return c.json({ ok: true });
});

// ---- Procurement -----------------------------------------------------------------------------------
api.get("/procurement", (c) => {
  const { limit, offset } = page(c, 50);
  const where: string[] = []; const p: (string | number)[] = [];
  const f = (col: string, key: string) => { const v = c.req.query(key); if (v) { where.push(`${col}=?`); p.push(v); } };
  f("source_key", "source"); f("demand_class", "demand"); f("country", "country"); f("contract_nature", "nature");
  if (c.req.query("authority")) { where.push("(authority_tags LIKE ? OR contracting_authority LIKE ?)"); p.push(`%"${c.req.query("authority")}"%`, `%${c.req.query("authority")}%`); }
  if (c.req.query("cpv")) { where.push("cpv_codes LIKE ?"); p.push(`%"${c.req.query("cpv")}%`); }
  if (c.req.query("category")) { const cat = CATEGORIES.find((x) => x.key === c.req.query("category")); if (cat) { where.push("(" + cat.cpv.map(() => "cpv_codes LIKE ?").join(" OR ") + ")"); p.push(...cat.cpv.map((x) => `%"${x}%`)); } }
  if (c.req.query("open") === "1") { where.push("(deadline IS NULL OR deadline > ?)"); p.push(now()); }
  if (c.req.query("q")) { where.push("(title LIKE ? OR description LIKE ? OR contracting_authority LIKE ?)"); const q = `%${c.req.query("q")}%`; p.push(q, q, q); }
  const w = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const cols = "id, source_key, retrieved_via, source_notice_id, source_url, publication_date, retrieval_timestamp, contracting_authority, authority_tags, title, substr(description,1,400) description, cpv_codes, deadline, estimated_value, currency, notice_type, procurement_status, country, data_completeness, missing_fields, demand_class, awarded_suppliers";
  return c.json({ total: count(`SELECT COUNT(*) n FROM procurement_notices ${w}`, ...p), rows: db().all(`SELECT ${cols} FROM procurement_notices ${w} ORDER BY publication_date DESC, id DESC LIMIT ? OFFSET ?`, ...p, limit, offset) });
});
api.get("/procurement/:id", (c) => {
  const n = db().get<Record<string, unknown>>("SELECT * FROM procurement_notices WHERE id=?", Number(c.req.param("id")));
  if (!n) return c.json({ error: "Notice not found" }, 404);
  return c.json({ ...n, original_payload: json(n.original_payload, null), cpv_categories: categoriesForCpv(json<string[]>(n.cpv_codes, [])), matches: db().all("SELECT m.id, m.status, m.score, m.supplier_company_id, co.canonical_name supplier FROM matches m JOIN companies co ON co.id=m.supplier_company_id WHERE m.procurement_notice_id=? ORDER BY m.score DESC LIMIT 50", Number(c.req.param("id"))) });
});
api.post("/procurement/sync", async (c) => {
  const b = await body(c, z.object({ source: z.enum(["ted", "ezamowienia"]), filter: z.string().optional(), sinceDate: z.string().regex(/^\d{4}-\d\d-\d\d$/).optional(), maxRecords: z.number().int().max(20000).optional(), days: z.number().int().max(31).optional() }));
  if (b.source === "ted" && b.filter && !(b.filter in TED_FILTERS)) return c.json({ error: `Unknown filter. Available: ${Object.keys(TED_FILTERS).join(", ")}` }, 400);
  return c.json({ taskId: enqueueTask("buyer_intelligence", "procurement.sync", b, `user:${uid(c)}`, { priority: 2 }) });
});
api.get("/procurement-filters", (c) => c.json({ ted: Object.entries(TED_FILTERS).map(([key, v]) => ({ key, label: v.label })), categories: CATEGORIES.map((x) => ({ key: x.key, label: x.label })) }));
// Manually collected official source (e.g. a notice found on a CAPTCHA-protected authority website). Labelled with its real collection method.
api.post("/procurement/manual", async (c) => {
  const b = await body(c, z.object({ title: z.string().min(3), authority: z.string().min(2), sourceUrl: z.string().url(), description: z.string().optional(), publicationDate: z.string().optional(), deadline: z.string().optional(), cpvCodes: z.array(z.string()).default([]), note: z.string().min(3) }));
  const { storeNotice } = await import("../services/procurement-store.ts");
  const r = storeNotice({ sourceKey: "manual", retrievedVia: `Manually imported by user ${uid(c)}`, sourceNoticeId: b.sourceUrl, sourceUrl: b.sourceUrl, publicationDate: b.publicationDate ?? null, originalPayload: { ...b, collectedBy: uid(c), collectedAt: now() }, contractingAuthority: b.authority, authorityNationalId: null, title: b.title, description: b.description ?? null, cpvCodes: b.cpvCodes, deadline: b.deadline ?? null, estimatedValue: null, currency: null, lots: [], technicalRequirements: null, noticeType: "manual", procurementStatus: null, legalBasis: null, contractNature: null, country: null, awardedSuppliers: [] });
  return c.json({ result: r });
});
api.post("/procurement/import-nspa-xml", async (c) => {
  const xml = await c.req.text();
  const src = upsertSource(`user-upload:nspa-xml:${Date.now()}`, "USER_PROVIDED", "NSPA XML upload");
  db().insert("source_snapshots", { source_id: src, content_type: "application/xml", byte_size: xml.length, body: xml.slice(0, 5_000_000) });
  return c.json({ stored: true, recordsCreated: 0, note: "The file was stored as raw evidence. The NSPA feed schema has not been verified against official documentation, so no notices were parsed or created. Provide the official XSD to enable parsing." });
});
api.get("/connectors", (c) => c.json(db().all("SELECT * FROM connector_status ORDER BY kind, key").map((r) => ({ ...(r as object), failed_requests: (r as { failed_requests: number }).failed_requests }))));
api.get("/ingestion-jobs", (c) => c.json(db().all("SELECT * FROM ingestion_jobs ORDER BY id DESC LIMIT 50")));
api.get("/authorities", (c) => c.json(db().all<{ canonical_key: string; match_patterns: string }>("SELECT * FROM authority_mappings").map((m) => ({ ...m, noticesInDatabase: count("SELECT COUNT(*) n FROM procurement_notices WHERE authority_tags LIKE ?", `%"${m.canonical_key}"%`), lastPublication: db().get<{ d: string | null }>("SELECT MAX(publication_date) d FROM procurement_notices WHERE authority_tags LIKE ?", `%"${m.canonical_key}"%`)?.d ?? null }))));

// ---- Marketplace (tenant-scoped) -------------------------------------------------------------
const reqSchema = z.object({ companyId: z.number().int(), title: z.string().min(3), description: z.string().optional(), categoryKeys: z.array(z.string()).default([]), cpvCodes: z.array(z.string()).default([]), quantity: z.number().positive().optional(), unit: z.string().optional(), currency: z.string().optional(), deliveryLocation: z.string().optional(), neededBy: z.string().optional(), certificationsRequired: z.array(z.string()).default([]), procurementNoticeId: z.number().int().optional(), originEventId: z.number().int().optional() });
api.post("/requirements", async (c) => {
  const b = await body(c, reqSchema);
  requireMember(uid(c), b.companyId, "MEMBER");
  const id = db().insert("buyer_requirements", { company_id: b.companyId, title: b.title, description: b.description, category_keys: JSON.stringify(b.categoryKeys), cpv_codes: JSON.stringify(b.cpvCodes), quantity: b.quantity, unit: b.unit, currency: b.currency, delivery_location: b.deliveryLocation, needed_by: b.neededBy, certifications_required: JSON.stringify(b.certificationsRequired), demand_class: "USER_PROVIDED_DEMAND", procurement_notice_id: b.procurementNoticeId, origin_event_id: b.originEventId, created_by_user_id: uid(c) });
  audit({ actorType: "user", actorId: uid(c), companyId: b.companyId, action: "requirement.created", entityType: "requirement", entityId: id, summary: `Buyer requirement: ${b.title}` });
  for (const s of db().all<{ id: number }>("SELECT DISTINCT company_id id FROM company_capabilities WHERE company_id != ?", b.companyId)) enqueueTask("matching", "matching.run", { supplierId: s.id }, `user:${uid(c)}`, { dedupeKey: `match:${s.id}`, priority: 8 });
  return c.json({ id }, 201);
});
api.get("/requirements", (c) => { const cid = Number(c.req.query("companyId")); requireMember(uid(c), cid); return c.json(db().all("SELECT * FROM buyer_requirements WHERE company_id=? ORDER BY id DESC", cid)); });
api.post("/offerings", async (c) => {
  const b = await body(c, z.object({ companyId: z.number().int(), title: z.string().min(3), description: z.string().optional(), categoryKeys: z.array(z.string()).default([]), cpvCodes: z.array(z.string()).default([]), currency: z.string().optional(), moq: z.number().positive().optional(), leadTimeDays: z.number().int().positive().optional(), certifications: z.array(z.string()).default([]) }));
  requireMember(uid(c), b.companyId, "MEMBER");
  const id = db().insert("supplier_offerings", { company_id: b.companyId, title: b.title, description: b.description, category_keys: JSON.stringify(b.categoryKeys), cpv_codes: JSON.stringify(b.cpvCodes), currency: b.currency, moq: b.moq, lead_time_days: b.leadTimeDays, certifications: JSON.stringify(b.certifications), confirmed_by_company: 1, created_by_user_id: uid(c) });
  // A confirmed offering is a company-supplied capability statement with the company as the source.
  for (const k of b.categoryKeys) db().run("INSERT OR IGNORE INTO company_capabilities (company_id, category_key, label, capability_class, source_url, source_type, evidence_text, confidence, verification_status) VALUES (?,?,?,?,?,?,?,?, 'VERIFIED')", b.companyId, k, CATEGORIES.find((x) => x.key === k)?.label ?? k, "VERIFIED_CAPABILITY", `arsenal:offering:${id}`, "USER_PROVIDED", `Offering "${b.title}" published by the company's authorised user ${uid(c)}`, 0.95);
  for (const cert of b.certifications) db().run("INSERT OR IGNORE INTO company_certifications (company_id, name, fact_kind, source_url, evidence_text, confidence, verification_status) VALUES (?,?,?,?,?,?, 'UNVERIFIED')", b.companyId, cert, "USER_PROVIDED", `arsenal:offering:${id}`, "Declared by company representative; certificate document not checked", 0.7);
  audit({ actorType: "user", actorId: uid(c), companyId: b.companyId, action: "offering.created", entityType: "offering", entityId: id, summary: `Supplier offering: ${b.title}` });
  enqueueTask("matching", "matching.run", { supplierId: b.companyId }, `user:${uid(c)}`, { dedupeKey: `match:${b.companyId}`, priority: 2 });
  return c.json({ id }, 201);
});
api.get("/offerings", (c) => { const cid = Number(c.req.query("companyId")); requireMember(uid(c), cid); return c.json(db().all("SELECT * FROM supplier_offerings WHERE company_id=? ORDER BY id DESC", cid)); });
api.get("/matches", (c) => {
  const { limit, offset } = page(c, 50);
  const mine = userCompanyIds(uid(c));
  const where: string[] = []; const p: (string | number)[] = [];
  // Notice-based matches are public information; requirement-based matches only appear for the buyer or the supplier.
  where.push(`(m.visible_to_company_id IS NULL OR m.visible_to_company_id IN (${mine.join(",") || "0"}) OR m.supplier_company_id IN (${mine.join(",") || "0"}))`);
  if (c.req.query("status")) { where.push("m.status=?"); p.push(c.req.query("status")!); }
  if (c.req.query("supplierId")) { where.push("m.supplier_company_id=?"); p.push(Number(c.req.query("supplierId"))); }
  if (c.req.query("eventId")) { where.push("m.supplier_company_id IN (SELECT company_id FROM event_exhibitors WHERE event_id=?)"); p.push(Number(c.req.query("eventId"))); }
  const w = where.join(" AND ");
  const rows = db().all<Record<string, unknown>>(`SELECT m.*, co.canonical_name supplier_name, n.title notice_title, n.contracting_authority, n.source_url notice_url, n.deadline FROM matches m JOIN companies co ON co.id=m.supplier_company_id LEFT JOIN procurement_notices n ON n.id=m.procurement_notice_id WHERE ${w} ORDER BY m.score DESC, m.id DESC LIMIT ? OFFSET ?`, ...p, limit, offset);
  return c.json({ total: count(`SELECT COUNT(*) n FROM matches m WHERE ${w}`, ...p), rows: rows.map((r) => ({ ...r, evidence: json(r.evidence, []), missing_info: json(r.missing_info, []), risks: json(r.risks, []), category_keys: json(r.category_keys, []) })) });
});
api.post("/matching/run", async (c) => {
  const b = await body(c, z.object({ supplierId: z.number().int() }));
  return c.json({ taskId: enqueueTask("matching", "matching.run", b, `user:${uid(c)}`, { dedupeKey: `match:${b.supplierId}`, priority: 2 }) });
});

// ---- Negotiation & deals -----------------------------------------------------------------------------
const termsSchema = z.object({ unitPrice: z.number().nonnegative().nullable().default(null), currency: z.string().length(3).nullable().default(null), quantity: z.number().positive().nullable().default(null), moq: z.number().positive().nullable().default(null), deliveryTerms: z.string().nullable().default(null), deliveryLocation: z.string().nullable().default(null), leadTimeDays: z.number().int().nonnegative().nullable().default(null), paymentTerms: z.string().nullable().default(null), warranty: z.string().nullable().default(null), technicalSpecs: z.string().nullable().default(null), validUntil: z.string().nullable().default(null) });
const memberOfNeg = (c: Context<Env>, negId: number) => {
  const n = neg.getNegotiation(negId);
  const mine = userCompanyIds(uid(c));
  if (!mine.includes(n.buyer_company_id) && !mine.includes(n.supplier_company_id)) throw new Error("Forbidden: not a party to this negotiation");
  return { n, mine };
};
api.put("/companies/:id/policy/:side", async (c) => {
  const id = Number(c.req.param("id")); const side = c.req.param("side")!.toUpperCase();
  if (side !== "BUYER" && side !== "SUPPLIER") return c.json({ error: "side must be BUYER or SUPPLIER" }, 400);
  requireMember(uid(c), id, "ADMIN");
  const b = await body(c, z.object({ currency: z.string().length(3).nullable().optional(), max_unit_price: z.number().nullable().optional(), min_unit_price: z.number().nullable().optional(), max_quantity: z.number().nullable().optional(), min_quantity: z.number().nullable().optional(), max_discount_pct: z.number().nullable().optional(), allowed_payment_terms: z.string().nullable().optional(), max_lead_time_days: z.number().int().nullable().optional(), max_rounds: z.number().int().nullable().optional(), opening_unit_price: z.number().nullable().optional(), opening_lead_time_days: z.number().int().nullable().optional(), opening_payment_terms: z.string().nullable().optional(), opening_delivery_terms: z.string().nullable().optional(), opening_validity_days: z.number().int().nullable().optional(), autonomous_accept: z.number().int().min(0).max(1).optional(), approval_required_above_total: z.number().nullable().optional() }));
  neg.setPolicy(id, side, b, uid(c));
  return c.json({ ok: true });
});
api.get("/companies/:id/policy", (c) => { const id = Number(c.req.param("id")); requireMember(uid(c), id); return c.json(db().all("SELECT * FROM negotiation_policies WHERE company_id=?", id)); });
api.post("/negotiations", async (c) => {
  const b = await body(c, z.object({ buyerId: z.number().int(), supplierId: z.number().int(), subject: z.string().min(3), mode: z.enum(["REAL", "SANDBOX"]), requirementId: z.number().int().optional(), matchId: z.number().int().optional(), eventId: z.number().int().optional() }));
  const mine = userCompanyIds(uid(c));
  if (!mine.includes(b.buyerId) && !mine.includes(b.supplierId)) return c.json({ error: "Forbidden: you must belong to one of the two companies" }, 403);
  requireMember(uid(c), mine.includes(b.buyerId) ? b.buyerId : b.supplierId, "MEMBER");
  return c.json({ id: neg.createNegotiation({ ...b, userId: uid(c) }) }, 201);
});
api.get("/negotiations", (c) => {
  const mine = userCompanyIds(uid(c)).join(",") || "0";
  return c.json(db().all(`SELECT n.*, b.canonical_name buyer_name, s.canonical_name supplier_name FROM negotiations n JOIN companies b ON b.id=n.buyer_company_id JOIN companies s ON s.id=n.supplier_company_id WHERE n.buyer_company_id IN (${mine}) OR n.supplier_company_id IN (${mine}) ORDER BY n.id DESC`));
});
api.get("/negotiations/:id", (c) => {
  const id = Number(c.req.param("id")); const { n, mine } = memberOfNeg(c, id);
  // A party never sees the counterparty's policy; only its own.
  const ownSide = mine.includes(n.buyer_company_id) ? "buyer" : "supplier";
  return c.json({
    negotiation: { ...n, buyer_policy_snapshot: ownSide === "buyer" ? json(n.buyer_policy_snapshot, null) : undefined, supplier_policy_snapshot: ownSide === "supplier" ? json(n.supplier_policy_snapshot, null) : undefined },
    offers: db().all<{ terms: string }>("SELECT * FROM offers WHERE negotiation_id=? ORDER BY version", id).map((o) => ({ ...o, terms: json(o.terms, {}) })),
    rfqs: db().all("SELECT * FROM rfqs WHERE negotiation_id=?", id), transitions: db().all("SELECT * FROM negotiation_transitions WHERE negotiation_id=? ORDER BY id", id),
    acceptances: db().all("SELECT a.* FROM offer_acceptances a JOIN offers o ON o.id=a.offer_id WHERE o.negotiation_id=?", id),
    approvals: db().all("SELECT * FROM approvals WHERE entity_type='negotiation' AND entity_id=? ORDER BY id DESC", id),
    deal: db().get("SELECT * FROM deals WHERE negotiation_id=?", id) ?? null,
    emails: db().all("SELECT id, direction, to_address, from_address, subject, status, mode, created_at FROM email_messages WHERE company_id IN (?, ?) ORDER BY id DESC LIMIT 20", n.buyer_company_id, n.supplier_company_id),
  });
});
const offerRoute = (kind: "RFQ" | "QUOTATION" | "COUNTEROFFER") => async (c: Context<Env>) => {
  const id = Number(c.req.param("id")); const { n, mine } = memberOfNeg(c, id);
  const b = await body(c, z.object({ companyId: z.number().int(), terms: termsSchema, rationale: z.string().optional(), externalRecorded: z.boolean().default(false), approvalId: z.number().int().optional() }));
  if (!mine.includes(b.companyId)) return c.json({ error: "Forbidden" }, 403);
  requireMember(uid(c), b.companyId, "MEMBER");
  // externalRecorded: the user records an offer the counterparty actually sent (e.g. by email); it is stored as received, not judged against our limits.
  if (b.externalRecorded) {
    const other = b.companyId === n.buyer_company_id ? n.supplier_company_id : n.buyer_company_id;
    return c.json(neg.submitOffer({ negotiationId: id, fromCompanyId: other, kind, terms: b.terms as OfferTerms, origin: "EXTERNAL_RECORDED", actor: `user:${uid(c)} (recorded counterparty offer)`, rationale: b.rationale }), 201);
  }
  try {
    return c.json(neg.submitOffer({ negotiationId: id, fromCompanyId: b.companyId, kind, terms: b.terms as OfferTerms, origin: "HUMAN", actor: `user:${uid(c)}`, rationale: b.rationale, approvedApprovalId: b.approvalId }), 201);
  } catch (e) {
    if (e instanceof neg.NeedsApproval) {
      const aid = neg.requestApproval(id, b.companyId, `offer.${kind.toLowerCase()}`, e.reasons, { terms: b.terms, kind }, `user:${uid(c)}`);
      return c.json({ error: "APPROVAL_REQUIRED", approvalId: aid, reasons: e.reasons }, 409);
    }
    throw e;
  }
};
api.post("/negotiations/:id/rfq", offerRoute("RFQ"));
api.post("/negotiations/:id/quotation", offerRoute("QUOTATION"));
api.post("/negotiations/:id/counter", offerRoute("COUNTEROFFER"));
api.post("/negotiations/:id/accept", async (c) => {
  const id = Number(c.req.param("id")); const { n, mine } = memberOfNeg(c, id);
  const b = await body(c, z.object({ companyId: z.number().int(), offerId: z.number().int() }));
  if (!mine.includes(b.companyId)) return c.json({ error: "Forbidden" }, 403);
  requireMember(uid(c), b.companyId, "MEMBER");
  void n;
  return c.json(neg.acceptOffer({ negotiationId: id, offerId: b.offerId, companyId: b.companyId, userId: uid(c), agent: false, actor: `user:${uid(c)}` }));
});
api.post("/negotiations/:id/reject", async (c) => { const id = Number(c.req.param("id")); memberOfNeg(c, id); const b = await body(c, z.object({ reason: z.string().min(2) })); neg.reject(id, `user:${uid(c)}`, b.reason); return c.json({ ok: true }); });
api.post("/negotiations/:id/cancel", async (c) => { const id = Number(c.req.param("id")); memberOfNeg(c, id); neg.cancel(id, `user:${uid(c)}`, "cancelled by user"); return c.json({ ok: true }); });
api.post("/negotiations/:id/agent-step", async (c) => {
  const id = Number(c.req.param("id")); const { mine } = memberOfNeg(c, id);
  const b = await body(c, z.object({ companyId: z.number().int() }));
  if (!mine.includes(b.companyId)) return c.json({ error: "Forbidden" }, 403);
  const n = neg.getNegotiation(id);
  const agent = b.companyId === n.buyer_company_id ? "buyer_agent" : "supplier_agent";
  return c.json({ taskId: enqueueTask(agent, "negotiation.agent_step", { negotiationId: id, companyId: b.companyId }, `user:${uid(c)}`, { companyId: b.companyId, entityType: "negotiation", entityId: id, priority: 1 }) });
});
// Fully autonomous run: both company agents negotiate and close within their configured mandates. The caller must belong to one of the two companies.
api.post("/negotiations/:id/autopilot", async (c) => {
  const id = Number(c.req.param("id")); memberOfNeg(c, id);
  const b = await body(c, z.object({ rfqTerms: termsSchema.partial().default({}) }));
  return c.json(await runAutopilot(id, b.rfqTerms as Partial<OfferTerms>));
});
api.get("/deals", (c) => {
  const mine = userCompanyIds(uid(c)).join(",") || "0";
  return c.json(db().all(`SELECT d.*, b.canonical_name buyer_name, s.canonical_name supplier_name, e.name event_name FROM deals d JOIN companies b ON b.id=d.buyer_company_id JOIN companies s ON s.id=d.supplier_company_id LEFT JOIN events e ON e.id=d.origin_event_id WHERE d.buyer_company_id IN (${mine}) OR d.supplier_company_id IN (${mine}) ORDER BY d.id DESC`).map((d) => ({ ...(d as object), terms: json((d as { terms: string }).terms, {}) })));
});
api.get("/deals/:id", (c) => {
  const id = Number(c.req.param("id"));
  const d = db().get<{ negotiation_id: number; terms: string }>("SELECT * FROM deals WHERE id=?", id);
  if (!d) return c.json({ error: "Deal not found" }, 404);
  memberOfNeg(c, d.negotiation_id);
  return c.json({ humanApprovals: count("SELECT COUNT(*) n FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND decided_by_user_id IS NOT NULL", d.negotiation_id), deal: { ...d, terms: json(d.terms, {}) }, events: db().all("SELECT * FROM deal_events WHERE deal_id=? ORDER BY id", id), negotiation: neg.getNegotiation(d.negotiation_id), offers: db().all("SELECT * FROM offers WHERE negotiation_id=? ORDER BY version", d.negotiation_id), audit: db().all("SELECT * FROM audit_logs WHERE (entity_type='negotiation' AND entity_id=?) OR (entity_type='deal' AND entity_id=?) ORDER BY id", d.negotiation_id, id) });
});
api.get("/approvals", (c) => {
  const mine = userCompanyIds(uid(c)).join(",") || "0";
  return c.json(db().all(`SELECT * FROM approvals WHERE company_id IN (${mine}) ORDER BY status='PENDING' DESC, id DESC LIMIT 100`));
});
api.post("/approvals/:id/decide", async (c) => {
  const id = Number(c.req.param("id"));
  const b = await body(c, z.object({ approve: z.boolean() }));
  const a = db().get<{ company_id: number | null; entity_type: string; entity_id: number; payload: string | null; action: string }>("SELECT * FROM approvals WHERE id=?", id);
  if (!a?.company_id) return c.json({ error: "Approval not found" }, 404);
  const m = requireMember(uid(c), a.company_id, "ADMIN");
  if (m.authorization_level !== "SIGNATORY") return c.json({ error: "Forbidden: approvals require SIGNATORY authorization" }, 403);
  approveTask(id, uid(c), b.approve);
  return c.json({ ok: true, note: a.entity_type === "negotiation" && b.approve ? "Approved. Re-submit the offer with approvalId to apply it." : undefined });
});
api.get("/analytics/events", (c) => {
  const rows = db().all(`SELECT e.id, e.name, e.start_date,
    (SELECT COUNT(DISTINCT company_id) FROM event_exhibitors WHERE event_id=e.id AND company_id IS NOT NULL) companies,
    (SELECT COUNT(*) FROM matches m WHERE m.origin_event_id=e.id OR m.supplier_company_id IN (SELECT company_id FROM event_exhibitors WHERE event_id=e.id)) matches,
    (SELECT COUNT(*) FROM negotiations n WHERE n.origin_event_id=e.id AND n.mode='REAL') negotiations,
    (SELECT COUNT(*) FROM rfqs r JOIN negotiations n ON n.id=r.negotiation_id WHERE n.origin_event_id=e.id AND n.mode='REAL') rfqs,
    (SELECT COUNT(*) FROM quotations q JOIN rfqs r ON r.id=q.rfq_id JOIN negotiations n ON n.id=r.negotiation_id WHERE n.origin_event_id=e.id AND n.mode='REAL') quotations,
    (SELECT COUNT(*) FROM deals d WHERE d.origin_event_id=e.id AND d.mode='REAL') accepted_deals,
    (SELECT COALESCE(SUM(total_value),0) FROM deals d WHERE d.origin_event_id=e.id AND d.mode='REAL') accepted_value,
    (SELECT COUNT(*) FROM deals d WHERE d.origin_event_id=e.id AND d.mode='SANDBOX') sandbox_deals
    FROM events e ORDER BY e.id DESC`);
  return c.json({ note: "Only REAL transactions count as business. SANDBOX is shown separately. Completed (delivered/paid) transactions are not tracked, so completed value is always unknown.", rows });
});

// ---- Communication -----------------------------------------------------------------------------
api.get("/emails", (c) => { const cid = Number(c.req.query("companyId")); requireMember(uid(c), cid); return c.json({ smtpConfigured: smtpConfigured(), rows: db().all("SELECT * FROM email_messages WHERE company_id=? ORDER BY id DESC LIMIT 100", cid) }); });
api.post("/emails/draft", async (c) => {
  const b = await body(c, z.object({ companyId: z.number().int(), contactId: z.number().int(), subject: z.string().min(3), body: z.string().min(10), negotiationId: z.number().int().optional() }));
  requireMember(uid(c), b.companyId, "MEMBER");
  return c.json({ id: draftEmail({ ...b, createdBy: String(uid(c)) }) }, 201);
});
api.post("/emails/rfq-draft", async (c) => {
  const b = await body(c, z.object({ negotiationId: z.number().int(), contactId: z.number().int() }));
  const { n, mine } = memberOfNeg(c, b.negotiationId);
  if (!mine.includes(n.buyer_company_id)) return c.json({ error: "Only the buyer drafts the RFQ email" }, 403);
  const rfq = db().get<{ requested_terms: string }>("SELECT requested_terms FROM rfqs WHERE negotiation_id=? ORDER BY id DESC LIMIT 1", b.negotiationId);
  if (!rfq) return c.json({ error: "Record the RFQ first" }, 422);
  const buyer = db().get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", n.buyer_company_id)!;
  return c.json({ id: draftEmail({ companyId: n.buyer_company_id, contactId: b.contactId, subject: `RFQ: ${n.subject}`, body: rfqEmailBody({ buyerName: buyer.canonical_name, subject: n.subject, terms: json<OfferTerms>(rfq.requested_terms, {} as OfferTerms) }), negotiationId: b.negotiationId, createdBy: String(uid(c)) }) }, 201);
});
api.post("/emails/:id/send", async (c) => {
  const id = Number(c.req.param("id"));
  const m = db().get<{ company_id: number }>("SELECT company_id FROM email_messages WHERE id=?", id);
  if (!m) return c.json({ error: "Email not found" }, 404);
  const mem = requireMember(uid(c), m.company_id, "MEMBER");
  if (mem.authorization_level === "READ_ONLY") return c.json({ error: "Forbidden" }, 403);
  return c.json(await sendApprovedEmail(id, uid(c)));
});
api.post("/emails/incoming", async (c) => {
  const b = await body(c, z.object({ companyId: z.number().int(), fromAddress: z.string().email(), subject: z.string(), body: z.string().min(3) }));
  requireMember(uid(c), b.companyId, "MEMBER");
  return c.json(recordIncomingEmail(b), 201);
});
api.post("/emails/parse-terms", async (c) => { const b = await body(c, z.object({ text: z.string() })); return c.json(parseTermsFromText(b.text)); });
api.get("/calls", (c) => { const cid = Number(c.req.query("companyId")); requireMember(uid(c), cid); return c.json({ providerConfigured: twilioConfigured(), rows: db().all("SELECT * FROM voice_calls WHERE company_id=? ORDER BY id DESC", cid) }); });
api.post("/calls/prepare", async (c) => {
  const b = await body(c, z.object({ companyId: z.number().int(), contactId: z.number().int(), purpose: z.string().min(3), script: z.string().min(10) }));
  requireMember(uid(c), b.companyId, "MEMBER");
  return c.json({ id: prepareCall({ ...b, createdBy: String(uid(c)) }), note: twilioConfigured() ? "Prepared. Placing the call needs explicit approval." : "No voice provider configured: this is a reviewed script only, no call is placed." }, 201);
});
api.get("/contacts", (c) => c.json(db().all("SELECT * FROM company_contacts WHERE company_id=?", Number(c.req.query("companyId")))));

// ---- Field requests: the agent asks a person at the event for a photo, specification and presentation ----
api.post("/field/reps", async (c) => {
  const b = await body(c, z.object({ companyId: z.number().int(), name: z.string().min(1), email: z.string().email() }));
  requireMember(uid(c), b.companyId, "MEMBER");
  return c.json({ id: addFieldRep(b.companyId, b.name, b.email, uid(c)) }, 201);
});
api.post("/field/requests", async (c) => {
  const b = await body(c, z.object({ companyId: z.number().int(), repId: z.number().int(), eventId: z.number().int().optional(), targetCompanyId: z.number().int().optional(), standHint: z.string().optional(), autoNegotiate: z.boolean().optional(), rfqTerms: termsSchema.partial().optional() }));
  requireMember(uid(c), b.companyId, "MEMBER");
  return c.json({ taskId: enqueueTask("email", "field.request", b, `user:${uid(c)}`, { companyId: b.companyId, priority: 1 }) }, 201);
});
api.get("/field/requests", (c) => {
  const cid = Number(c.req.query("companyId")); requireMember(uid(c), cid);
  const rows = db().all<{ id: number; summary: string | null }>("SELECT r.*, p.name rep_name, p.email rep_email, (SELECT state FROM negotiations WHERE id=r.negotiation_id) negotiation_state, (SELECT id FROM deals WHERE negotiation_id=r.negotiation_id) deal_id FROM field_requests r JOIN field_reps p ON p.id=r.rep_id WHERE r.company_id=? ORDER BY r.id DESC", cid);
  return c.json({ inbox: mailpitUrl() ? "MAILPIT" : "NOT_CONFIGURED", reps: db().all("SELECT * FROM field_reps WHERE company_id=?", cid), rows: rows.map((r) => ({ ...r, summary: json(r.summary, null), briefing: json((r as { briefing?: string }).briefing ?? null, null), attachments: db().all("SELECT id, filename, content_type, size, kind, extraction_status, extracted FROM email_attachments WHERE field_request_id=?", r.id).map((a) => ({ ...(a as object), extracted: json((a as { extracted: string | null }).extracted, null) })) })) });
});
// A simulated supplier mandate for a PUBLIC company record, for SANDBOX runs only. It is stored flagged `simulated`, never impersonates the company,
// and is refused in REAL negotiations. The operator (any signed-in user) sets it explicitly; nothing is defaulted.
api.put("/sandbox/companies/:id/mandate", async (c) => {
  const id = Number(c.req.param("id"));
  const co = db().get<{ is_registered: number }>("SELECT is_registered FROM companies WHERE id=?", id);
  if (!co) return c.json({ error: "Company not found" }, 404);
  if (co.is_registered) return c.json({ error: "Registered companies configure their own mandate" }, 403);
  const b = await body(c, z.object({ currency: z.string().length(3), min_unit_price: z.number(), opening_unit_price: z.number(), opening_lead_time_days: z.number().int(), opening_payment_terms: z.string().min(2), opening_delivery_terms: z.string().min(2), opening_validity_days: z.number().int().min(1), min_quantity: z.number().optional(), max_rounds: z.number().int().optional() }));
  const cols = { ...b, side: "SUPPLIER", company_id: id, simulated: 1, autonomous_accept: 1, updated_by_user_id: uid(c) } as Record<string, string | number>;
  db().run("DELETE FROM negotiation_policies WHERE company_id=? AND side='SUPPLIER'", id);
  db().insert("negotiation_policies", cols);
  audit({ actorType: "user", actorId: uid(c), action: "sandbox.mandate_set", entityType: "company", entityId: id, summary: "SIMULATED supplier mandate set for a public company record (SANDBOX only)" });
  return c.json({ ok: true, simulated: true });
});
api.get("/vision/status", (c) => c.json({ configured: visionConfigured(), provider: visionProvider(), model: visionModel() }));
api.get("/deals/:id/pdf", (c) => {
  const id = Number(c.req.param("id"));
  const d = db().get<{ negotiation_id: number; deal_ref: string; mode: string; subject: string; terms: string; total_value: number | null; currency: string | null; accepted_at: string; buyer_company_id: number; supplier_company_id: number; status: string }>("SELECT * FROM deals WHERE id=?", id);
  if (!d) return c.json({ error: "Deal not found" }, 404);
  memberOfNeg(c, d.negotiation_id);
  const name = (cid: number) => db().get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", cid)!.canonical_name;
  const t = json<Record<string, unknown>>(d.terms, {});
  const lines = [`DEAL RECORD ${d.deal_ref}`, d.mode === "SANDBOX" ? "SANDBOX - SIMULATION, NOT A REAL TRANSACTION" : "REAL transaction record", "", `Subject: ${d.subject}`, `Buyer: ${name(d.buyer_company_id)}`, `Supplier: ${name(d.supplier_company_id)}`, `Accepted at: ${d.accepted_at}`, "", ...Object.entries(t).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${String(v)}`), `Total: ${d.total_value ?? "unknown"} ${d.currency ?? ""}`, "", `Status: ${d.status}`, "This is a recorded commercial acceptance, not a signed contract.", `Human approvals: ${count("SELECT COUNT(*) n FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND decided_by_user_id IS NOT NULL", d.negotiation_id)}`];
  return new Response(simplePdf(lines), { headers: { "content-type": "application/pdf", "content-disposition": `inline; filename="${d.deal_ref}.pdf"` } });
});
api.get("/field/attachments/:id/file", (c) => {
  const a = db().get<{ path: string; content_type: string | null; filename: string; company_id: number }>("SELECT a.path, a.content_type, a.filename, r.company_id FROM email_attachments a JOIN field_requests r ON r.id=a.field_request_id WHERE a.id=?", Number(c.req.param("id")));
  if (!a) return c.json({ error: "Attachment not found" }, 404);
  requireMember(uid(c), a.company_id);
  return new Response(readFileSync(a.path), { headers: { "content-type": a.content_type ?? "application/octet-stream", "content-disposition": `inline; filename="${a.filename.replace(/[^\w.\- ]/g, "_")}"`, "x-content-type-options": "nosniff" } });
});
api.post("/field/poll", async (c) => c.json(await pollInbox()));

// ---- Demo: setup + missions (the two demo scenarios) ----------------------------------------------------
const mailpit = () => process.env.MAILPIT_URL ?? null;
async function mailpitUp(): Promise<boolean> { const b = mailpit(); if (!b) return false; try { return (await fetch(`${b}/api/v1/info`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } }

api.get("/demo/setup", async (c) => {
  const cfg = getDemoConfig();
  const mine = userCompanyIds(uid(c));
  const company = cfg.buyerCompanyId && mine.includes(cfg.buyerCompanyId) ? db().get("SELECT id, canonical_name name, country, website FROM companies WHERE id=?", cfg.buyerCompanyId) : null;
  return c.json({
    company, buyerMandate: cfg.buyerCompanyId ? db().get("SELECT * FROM negotiation_policies WHERE company_id=? AND side='BUYER'", cfg.buyerCompanyId) ?? null : null,
    mandates: cfg.mandates, rep: cfg.rep, deliveryLocation: cfg.deliveryLocation,
    status: { smtp: !!(process.env.SMTP_HOST && process.env.SMTP_FROM), mailpitUrl: mailpit(), mailpitReachable: await mailpitUp(), vision: visionConfigured(), llm: !!process.env.OPENAI_API_KEY },
    events: db().all("SELECT e.id, e.name, e.start_date, (SELECT COUNT(*) FROM event_exhibitors x WHERE x.event_id=e.id AND x.removed_at IS NULL) exhibitors, (SELECT COUNT(*) FROM event_exhibitors x WHERE x.event_id=e.id AND x.resolution_status='PENDING_DETAIL') pending, e.research_status FROM events e ORDER BY e.id"),
    ready: !!(company && cfg.rep && (cfg.mandates.default || cfg.mandates.drone)),
  });
});
api.put("/demo/setup", async (c) => {
  const b = await body(c, z.object({
    buyer: z.object({ legalName: z.string().min(2), country: z.string().length(2), website: z.string().optional() }),
    buyerMandate: z.object({ currency: z.string().length(3), max_unit_price: z.number(), opening_unit_price: z.number(), max_lead_time_days: z.number().int(), allowed_payment_terms: z.string().min(2), max_quantity: z.number().optional() }),
    supplierMandate: z.object({ currency: z.string().length(3), min_unit_price: z.number(), opening_unit_price: z.number(), opening_lead_time_days: z.number().int(), opening_payment_terms: z.string().min(2), opening_delivery_terms: z.string().min(2), opening_validity_days: z.number().int().min(1) }),
    rep: z.object({ name: z.string().min(1), email: z.string().email() }),
    deliveryLocation: z.string().optional(),
    profile: z.enum(["default", "drone"]).default("default"),
  }));
  const u = uid(c);
  let companyId = getDemoConfig().buyerCompanyId;
  if (!companyId || !userCompanyIds(u).includes(companyId)) {
    const existing = userCompanyIds(u)[0];
    companyId = existing ?? onboardCompany({ userId: u, legalName: b.buyer.legalName, country: b.buyer.country, website: b.buyer.website, authorizationLevel: "SIGNATORY", jobTitle: "Demo operator" }).companyId;
  }
  neg.setPolicy(companyId, "BUYER", { ...b.buyerMandate, max_rounds: 8, autonomous_accept: 1 }, u);
  putDemoConfig("buyerCompanyId", companyId); putDemoConfig("deliveryLocation", b.deliveryLocation ?? null);
  putDemoConfig("mandates", { ...getDemoConfig().mandates, [b.profile]: { buyer: b.buyerMandate, supplier: b.supplierMandate } });
  putDemoConfig("rep", { id: addFieldRep(companyId, b.rep.name, b.rep.email, u), name: b.rep.name, email: b.rep.email });
  audit({ actorType: "user", actorId: u, companyId, action: "demo.setup", summary: "Demo mandates and salesperson configured (supplier mandate is a simulated SANDBOX template)" });
  return c.json({ ok: true, companyId });
});
// The salesperson's phone: sends a REAL email (SMTP) from the configured rep address to the agent mailbox. A normal mail client works equally well.
api.post("/missions/:id/rep-reply", async (c) => {
  const id = Number(c.req.param("id"));
  const m = db().get<{ company_id: number; field_request_id: number | null }>("SELECT company_id, field_request_id FROM missions WHERE id=?", id);
  if (!m?.field_request_id) return c.json({ error: "Mission has no open field request" }, 404);
  requireMember(uid(c), m.company_id, "MEMBER");
  const b = await body(c, z.object({ note: z.string().max(1000).default(""), useDemoAssets: z.boolean().default(false), set: z.enum(["thermal", "drone"]).default("thermal"), files: z.array(z.object({ name: z.string().max(120), type: z.string().max(100), base64: z.string() })).max(6).default([]) }));
  const fr = db().get<{ token: string; rep_email: string }>("SELECT r.token, p.email rep_email FROM field_requests r JOIN field_reps p ON p.id=r.rep_id WHERE r.id=?", m.field_request_id)!;
  if (!(process.env.SMTP_HOST && process.env.SMTP_FROM)) return c.json({ error: "SMTP is not configured" }, 422);
  let attachments = b.files.map((f) => ({ filename: f.name.replace(/[^\w.\- ]/g, "_"), content: Buffer.from(f.base64, "base64"), contentType: f.type }));
  if (b.useDemoAssets) {
    const dir = resolve(import.meta.dirname!, "../../demo-assets", b.set);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.(jpe?g|png|webp|pdf|txt)$/i.test(f)) : [];
    if (!files.length) return c.json({ error: `No prepared files in apps/api/demo-assets/${b.set}/. Put a real photo and spec there.` }, 422);
    putDemoConfig(`fixture_reply:${m.field_request_id}`, true); // demo material: never recorded as claims about a real company
    attachments = files.map((f) => ({ filename: f, content: readFileSync(resolve(dir, f)), contentType: /\.pdf$/i.test(f) ? "application/pdf" : /\.txt$/i.test(f) ? "text/plain" : /\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg" }));
  }
  if (!attachments.length && !b.note.trim()) return c.json({ error: "Attach a photo or a spec, or write a note" }, 400);
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true" });
  await t.sendMail({ from: fr.rep_email, to: process.env.SMTP_FROM, subject: `Re: Jesteś na evencie? [${fr.token}]`, text: b.note || "Jestem przy stoisku. Zdjęcie i specyfikacja w załączniku.", attachments });
  enqueueTask("email", "field.poll", {}, `user:${uid(c)}`, { dedupeKey: "field-poll", priority: 1 });
  audit({ actorType: "user", actorId: uid(c), companyId: m.company_id, action: "field_request.rep_reply_sent", entityType: "field_request", entityId: m.field_request_id, summary: `Salesperson reply emailed with ${attachments.length} attachment(s)` });
  return c.json({ ok: true, attachments: attachments.length });
});
// ---- Pre-event: supplier-agent profiles and hand-over to the event ----------------------------------------------
const profileBody = z.object({ eventId: z.number().int(), focus: z.string().min(5), stand: z.string().nullish(), daysPresent: z.string().nullish(), attendees: z.array(z.object({ name: z.string().min(1), role: z.string().min(1) })).default([]), bringing: z.array(z.string().min(1)).default([]), shareable: z.array(z.string().min(1)).default([]), gated: z.array(z.object({ topic: z.string().min(1), how: z.string().min(1) })).default([]), meetingSlots: z.array(z.string().min(1)).default([]) });
api.get("/preevent/profiles", (c) => c.json(db().all<{ company_id: number }>("SELECT p.company_id, co.canonical_name name, co.is_registered, p.own_company, p.event_id, e.name event_name, p.focus, p.stand FROM supplier_profiles p JOIN companies co ON co.id=p.company_id LEFT JOIN events e ON e.id=p.event_id ORDER BY p.updated_at DESC").map((r) => ({ ...r, profile: loadProfile(r.company_id) }))));
api.put("/preevent/profiles/:companyId", async (c) => {
  const companyId = Number(c.req.param("companyId"));
  const co = db().get<{ is_registered: number }>("SELECT is_registered FROM companies WHERE id=?", companyId);
  if (!co) return c.json({ error: "Company not found" }, 404);
  if (co.is_registered) requireMember(uid(c), companyId, "MEMBER");
  const b = await body(c, profileBody);
  saveProfile(companyId, { event_id: b.eventId, own_company: co.is_registered ? 1 : 0, focus: b.focus, stand: b.stand ?? null, days_present: b.daysPresent ?? null, attendees: b.attendees, bringing: b.bringing, shareable: b.shareable, gated: b.gated, meeting_slots: b.meetingSlots }, uid(c));
  return c.json({ ok: true, simulated: !co.is_registered });
});
api.post("/preevent/own-company", async (c) => {
  const b = await body(c, z.object({ name: z.string().min(2), country: z.string().length(2).default("PL"), website: z.string().optional() }));
  const r = onboardCompany({ userId: uid(c), legalName: b.name, country: b.country, website: b.website, authorizationLevel: "SIGNATORY", jobTitle: "Demo operator" });
  return c.json({ companyId: r.companyId }, 201);
});
// The meeting is agreed; now go to the stand. Whatever the supplier keeps gated becomes the salesperson's checklist.
api.post("/missions/:id/continue-at-event", async (c) => {
  const id = Number(c.req.param("id"));
  const m = db().get<{ company_id: number; target_company_id: number | null; event_id: number | null; parsed: string | null }>("SELECT company_id, target_company_id, event_id, parsed FROM missions WHERE id=? AND kind='PREEVENT'", id);
  if (!m?.target_company_id || !m.event_id) return c.json({ error: "Pre-event mission not found" }, 404);
  requireMember(uid(c), m.company_id, "MEMBER");
  const cfg = getDemoConfig();
  const parsed = json<{ categoryKey?: string; quantity?: number | null }>(m.parsed, {});
  const profile = loadProfile(m.target_company_id);
  const prof = parsed.categoryKey === "uav_drones" ? "drone" : "default";
  if (!cfg.rep || !cfg.mandates[prof]) return c.json({ error: `Save the ${prof} mandates and the salesperson in Setup first.` }, 422);
  const lines = ["Z rozmowy agentów przed eventem:", profile?.attendees[0] ? `• Szukaj: ${profile.attendees[0].name} (${profile.attendees[0].role})${profile.stand ? `, ${profile.stand}` : ""}${profile.meeting_slots[0] ? `, spotkanie: ${profile.meeting_slots[0]}` : ""}` : "", ...(profile?.gated.length ? ["", "Tego nie dało się ustalić przed eventem (tylko na miejscu) — dowiedz się:", ...profile.gated.map((g) => `• ${g.topic} (${g.how})`)] : []) ].filter((x, i, a) => !(x === "" && (i === 0 || a[i - 1] === "")));
  const mid = db().insert("missions", { company_id: m.company_id, user_id: uid(c), kind: "FIELD", prompt: `Continue at the event (from pre-event mission #${id})`, status: "RUNNING" });
  addStep(mid, "start", `Continuing at the event after pre-event mission #${id}: the salesperson gets the checklist of what could not be learned by email`, "DONE");
  const taskId = enqueueTask("buyer_agent", "mission.run", { missionId: mid, field: { eventId: m.event_id, targetCompanyId: m.target_company_id, standHint: profile?.stand ?? null, quantity: parsed.quantity ?? null, profile: prof, extraLines: lines } }, `user:${uid(c)}`, { companyId: m.company_id, priority: 1 });
  return c.json({ id: mid, taskId }, 201);
});
api.get("/demo/suggestions", (c) => c.json(["Find me events where I can source 200 thermal cameras by Q1.", "Find me events where I can source 10 military reconnaissance drones by Q2.", "Find me events where I can source 50 tactical radios by Q1."]));
api.get("/demo/suggestions-preevent", (c) => c.json(["Find me a war-tech startup that builds autonomous counter-drone interceptors.", "Find me a startup that builds counter-drone interceptors, 20 units by Q2."]));

api.post("/missions", async (c) => {
  const b = await body(c, z.object({ prompt: z.string().min(8).max(400).optional(), field: z.object({ eventId: z.number().int(), targetCompanyId: z.number().int(), standHint: z.string().nullish(), quantity: z.number().positive().nullish(), profile: z.enum(["default", "drone"]).optional() }).optional(), preevent: z.object({ supplierCompanyId: z.number().int().optional() }).optional() }));
  const cfg = getDemoConfig();
  const needFull = !b.preevent;
  if (!cfg.buyerCompanyId || !userCompanyIds(uid(c)).includes(cfg.buyerCompanyId) || (needFull && (!cfg.rep || !(cfg.mandates.default || cfg.mandates.drone)))) return c.json({ error: "Complete the demo setup first (buyer company, mandates, salesperson)." }, 422);
  if (!b.prompt && !b.field) return c.json({ error: "Provide a prompt or a field target" }, 400);
  const kind = b.field ? "FIELD" : b.preevent ? "PREEVENT" : "SOURCING";
  const id = db().insert("missions", { company_id: cfg.buyerCompanyId, user_id: uid(c), kind, prompt: b.prompt ?? `Field visit: company ${b.field!.targetCompanyId}`, status: "RUNNING" });
  addStep(id, "start", b.prompt ? `Request: "${b.prompt}"` : "Field mode: you are at the event", "DONE");
  const taskId = enqueueTask("buyer_agent", "mission.run", { missionId: id, preevent: b.preevent, field: b.field ? { ...b.field, standHint: b.field.standHint ?? null, quantity: b.field.quantity ?? null } : undefined }, `user:${uid(c)}`, { companyId: cfg.buyerCompanyId, priority: 1 });
  return c.json({ id, taskId }, 201);
});
api.get("/missions", (c) => { const mine = userCompanyIds(uid(c)).join(",") || "0"; return c.json(db().all(`SELECT id, kind, prompt, status, created_at FROM missions WHERE archived=0 AND company_id IN (${mine}) ORDER BY id DESC LIMIT 20`)); });
// Hides earlier runs from the start screen; nothing is deleted.
api.post("/missions/archive-all", (c) => { const mine = userCompanyIds(uid(c)).join(",") || "0"; return c.json({ archived: db().run(`UPDATE missions SET archived=1 WHERE company_id IN (${mine})`).changes }); });
api.get("/missions/:id", (c) => {
  const id = Number(c.req.param("id"));
  const m = db().get<Record<string, unknown> & { company_id: number; field_request_id: number | null; deal_id: number | null; negotiation_id: number | null }>("SELECT * FROM missions WHERE id=?", id);
  if (!m) return c.json({ error: "Mission not found" }, 404);
  requireMember(uid(c), m.company_id);
  const fr = m.field_request_id ? db().get<Record<string, unknown>>("SELECT * FROM field_requests WHERE id=?", m.field_request_id) : undefined;
  const hasDeal = m.deal_id ? db().get<{ deal_ref: string; mode: string; total_value: number | null; currency: string | null; terms: string }>("SELECT * FROM deals WHERE id=?", m.deal_id) : undefined;
  return c.json({
    mission: { ...m, parsed: json(m.parsed as string, null), ranking: json(m.ranking as string, []), plan: json(m.plan as string, []) },
    steps: db().all<{ detail: string | null }>("SELECT * FROM mission_steps WHERE mission_id=? ORDER BY id", id).map((s) => ({ ...s, detail: json(s.detail, null) })),
    field: fr ? { fixture: !!getDb().get("SELECT 1 FROM demo_config WHERE key=?", `fixture_reply:${String(fr.id)}`), token: fr.token, status: fr.status, summary: json(fr.summary as string, null), briefing: json(fr.briefing as string, null), attachments: db().all<{ extracted: string | null }>("SELECT id, filename, kind, extraction_status, extracted FROM email_attachments WHERE field_request_id=?", fr.id as number).map((a) => ({ ...a, extracted: json(a.extracted, null) })) } : null,
    offers: m.negotiation_id ? db().all<{ terms: string }>("SELECT version, kind, from_company_id, terms, status, origin, created_at FROM offers WHERE negotiation_id=? ORDER BY version", m.negotiation_id).map((o) => ({ ...o, terms: json(o.terms, {}) })) : [],
    negotiation: m.negotiation_id ? db().get("SELECT id, state, round, mode, buyer_company_id, supplier_company_id FROM negotiations WHERE id=?", m.negotiation_id) : null,
    deal: hasDeal ? { id: m.deal_id, ...hasDeal, terms: json(hasDeal.terms, {}), humanApprovals: count("SELECT COUNT(*) n FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND decided_by_user_id IS NOT NULL", m.negotiation_id as number), pendingApprovals: count("SELECT COUNT(*) n FROM approvals WHERE entity_type='negotiation' AND entity_id=? AND status='PENDING'", m.negotiation_id as number), ledger: db().all("SELECT created_at, action, summary FROM audit_logs WHERE (entity_type='negotiation' AND entity_id=?) OR (entity_type='deal' AND entity_id=?) ORDER BY id", m.negotiation_id as number, m.deal_id as number) } : null,
    mailpitUrl: mailpit(),
  });
});
// The mission's real emails, read from the mailbox.
api.get("/missions/:id/emails", async (c) => {
  const id = Number(c.req.param("id"));
  const m = db().get<{ company_id: number; field_request_id: number | null; negotiation_id: number | null }>("SELECT company_id, field_request_id, negotiation_id FROM missions WHERE id=?", id);
  if (!m) return c.json({ error: "Mission not found" }, 404);
  requireMember(uid(c), m.company_id);
  const base = mailpit(); if (!base) return c.json({ configured: false, messages: [] });
  const token = m.field_request_id ? db().get<{ token: string }>("SELECT token FROM field_requests WHERE id=?", m.field_request_id)?.token : null;
  try {
    const list = (await (await fetch(`${base}/api/v1/messages?limit=200`)).json()) as { messages?: { ID: string; Subject: string; From: { Address: string }; To: { Address: string }[]; Created: string; Attachments: number; Snippet: string }[] };
    const mine = (list.messages ?? []).filter((x) => (token && x.Subject.includes(token)) || x.Subject.includes(`[PRE-${id}-`) || (m.negotiation_id && (x.Subject.includes(`[NEG-${m.negotiation_id}-`) || x.Subject.includes(`[NEG-${m.negotiation_id}]`)))).sort((a, b) => a.Created.localeCompare(b.Created));
    return c.json({ configured: true, messages: mine.map((x) => ({ id: x.ID, subject: x.Subject, from: x.From.Address, to: x.To.map((t) => t.Address).join(", "), created: x.Created, attachments: x.Attachments, snippet: x.Snippet })) });
  } catch (e) { return c.json({ configured: true, error: errorMessage(e), messages: [] }); }
});
api.get("/missions/:id/emails/:mid", async (c) => {
  const base = mailpit(); if (!base) return c.json({ error: "Mailpit not configured" }, 400);
  const d = (await (await fetch(`${base}/api/v1/message/${encodeURIComponent(c.req.param("mid")!)}`)).json()) as { Subject: string; From: { Address: string }; To: { Address: string }[]; Text: string; Attachments: { FileName: string }[] };
  return c.json({ subject: d.Subject, from: d.From.Address, to: d.To.map((t) => t.Address).join(", "), text: d.Text, attachments: d.Attachments.map((a) => a.FileName) });
});
void rankEvents; void errorMessage;

// ---- Agents & tasks -------------------------------------------------------------------------------
api.get("/agents", (c) => c.json(db().all<{ key: string; permissions: string; tools: string }>("SELECT * FROM agents ORDER BY rowid").map((a) => ({ ...a, permissions: json(a.permissions, []), tools: json(a.tools, []),
  queued: count("SELECT COUNT(*) n FROM agent_tasks WHERE agent_key=? AND status IN ('QUEUED','RETRY_SCHEDULED')", a.key), running: count("SELECT COUNT(*) n FROM agent_tasks WHERE agent_key=? AND status='RUNNING'", a.key),
  failed: count("SELECT COUNT(*) n FROM agent_tasks WHERE agent_key=? AND status='FAILED'", a.key), lastError: db().get<{ error: string }>("SELECT error FROM agent_tasks WHERE agent_key=? AND status='FAILED' ORDER BY id DESC LIMIT 1", a.key)?.error ?? null }))));
api.patch("/agents/:key", async (c) => {
  const key = c.req.param("key")!;
  if (!(AGENT_KEYS as readonly string[]).includes(key)) return c.json({ error: "Unknown agent" }, 404);
  const b = await body(c, z.object({ enabled: z.boolean() }));
  db().run("UPDATE agents SET enabled=? WHERE key=?", b.enabled ? 1 : 0, key);
  audit({ actorType: "user", actorId: uid(c), action: b.enabled ? "agent.enabled" : "agent.disabled", summary: `Agent ${key} ${b.enabled ? "enabled" : "disabled"}` });
  return c.json({ ok: true });
});
const USER_STARTABLE: Record<string, string[]> = { email: ["field.poll"], event_discovery: ["event.discover"], event_research: ["event.research", "event.exhibitor_details"], event_monitoring: ["event.monitor"], company_identity: ["company.identity"], company_discovery: ["company.enrich"], buyer_intelligence: ["procurement.sync"], supplier_intelligence: ["procurement.derive_suppliers"], matching: ["matching.run"] };
api.post("/tasks", async (c) => {
  const b = await body(c, z.object({ agent: z.string(), type: z.string(), payload: z.record(z.string(), z.unknown()).default({}) }));
  if (!USER_STARTABLE[b.agent]?.includes(b.type)) return c.json({ error: `Task type ${b.type} cannot be started manually for ${b.agent}` }, 400);
  return c.json({ taskId: enqueueTask(b.agent as never, b.type, b.payload, `user:${uid(c)}`, { priority: 2 }) }, 201);
});
api.get("/tasks", (c) => {
  const { limit, offset } = page(c, 50);
  const where: string[] = []; const p: (string | number)[] = [];
  if (c.req.query("status")) { where.push("status=?"); p.push(c.req.query("status")!); }
  if (c.req.query("agent")) { where.push("agent_key=?"); p.push(c.req.query("agent")!); }
  const mine = userCompanyIds(uid(c)).join(",") || "0";
  where.push(`(company_id IS NULL OR company_id IN (${mine}))`);
  return c.json(db().all(`SELECT id, agent_key, type, status, priority, progress_note, error, attempts, max_attempts, entity_type, entity_id, started_at, finished_at, created_by, created_at FROM agent_tasks WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ? OFFSET ?`, ...p, limit, offset));
});
api.get("/tasks/:id", (c) => {
  const id = Number(c.req.param("id"));
  const t = db().get<{ payload: string; result: string | null; company_id: number | null }>("SELECT * FROM agent_tasks WHERE id=?", id);
  if (!t) return c.json({ error: "Task not found" }, 404);
  if (t.company_id && !userCompanyIds(uid(c)).includes(t.company_id)) return c.json({ error: "Forbidden" }, 403);
  return c.json({ task: { ...t, payload: json(t.payload, {}), result: json(t.result, null) }, executions: db().all("SELECT * FROM agent_executions WHERE task_id=? ORDER BY id", id), actions: db().all("SELECT * FROM agent_actions WHERE task_id=? ORDER BY id", id), messages: db().all("SELECT * FROM agent_messages WHERE task_id=? OR from_agent IN (SELECT agent_key FROM agent_tasks WHERE id=?) LIMIT 20", id, id), scrapes: db().all("SELECT url, status, http_status, duration_ms, from_cache, error, created_at FROM scraping_jobs WHERE task_id=? ORDER BY id DESC LIMIT 100", id) });
});
api.post("/tasks/:id/cancel", (c) => c.json({ cancelled: cancelTask(Number(c.req.param("id")), String(uid(c))) }));
api.post("/tasks/:id/retry", (c) => {
  const id = Number(c.req.param("id"));
  const r = db().run("UPDATE agent_tasks SET status='QUEUED', attempts=0, error=NULL, finished_at=NULL, run_after=?, updated_at=? WHERE id=? AND status IN ('FAILED','CANCELLED')", now(), now(), id);
  return c.json({ requeued: r.changes > 0 });
});

// ---- MCP ----------------------------------------------------------------------------------------
api.get("/mcp/registry", (c) => { syncConfiguredServers(); return c.json({ configPath: process.env.ARSENAL_MCP_CONFIG ? "set" : "not set", configuredServers: Object.keys(loadMcpConfig()), registry: registry() }); });
api.post("/mcp/discover/:server", async (c) => c.json(await discoverServer(c.req.param("server")!)));
api.post("/mcp/execute", async (c) => {
  const b = await body(c, z.object({ server: z.string(), tool: z.string(), input: z.record(z.string(), z.unknown()).default({}), permissions: z.array(z.enum(["mcp:read", "mcp:act"])).default(["mcp:read"]) }));
  return c.json(await executeMcpTool({ server: b.server, tool: b.tool, input: b.input, userId: uid(c), grantedPermissions: b.permissions }));
});
api.get("/mcp/executions", (c) => c.json(db().all("SELECT * FROM mcp_tool_executions ORDER BY id DESC LIMIT 100")));
api.get("/audit", (c) => c.json(db().all("SELECT * FROM audit_logs ORDER BY id DESC LIMIT 200").filter((r) => { const cid = (r as { company_id: number | null }).company_id; return cid == null || userCompanyIds(uid(c)).includes(cid); })));
void normalizeCompanyName; void runMatchingForSupplier;
