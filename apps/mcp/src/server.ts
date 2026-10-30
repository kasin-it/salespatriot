#!/usr/bin/env node
// Arsenal AI MCP server. Lets Claude Desktop (or any MCP client) read Arsenal data and RETURN research results to the backend.
// The backend stays the source of truth: every write goes through its HTTP API with provenance and an audit entry.
import { readFile } from "node:fs/promises";
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.ARSENAL_API_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.ARSENAL_API_TOKEN;

async function call(path: string, body?: unknown, method?: "PUT"): Promise<unknown> {
  if (!TOKEN) throw new Error("ARSENAL_API_TOKEN is not set. Create a token in Arsenal AI → Settings.");
  const res = await fetch(`${BASE}/api${path}`, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Arsenal API ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const out = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

const INSTRUCTIONS = `Arsenal AI is a defence sourcing marketplace. You act as the BUYER's agent for the user (a procurement person).
How to work:
1. Start with arsenal_demo_setup. If not ready, say what is missing. Show the user their limits (mandate) and offer to change them with arsenal_set_mandate before a run: humans set the limits, agents act inside them.
2. To source a product, call arsenal_start_mission with the user's own words, then arsenal_wait_mission (never sleep or run shell commands to wait).
3. While it runs, narrate briefly what the agent decided and why: the event ranking, the stands, and the "reasoning" entries (written by the system's own agent, grounded in stored facts).
4. At WAITING_REPLY the salesperson at the event must reply. Ask the user whether to play the salesperson with the prepared files (arsenal_salesperson_reply); don't do it silently.
5. After DEAL_CLOSED, summarise the deal (price, quantity, lead time, total, human approvals) and link the real tenders it fits.
6. Use arsenal_find_tenders to answer questions about real demand; always give the source link.
Honesty: tenders, events and exhibitors are real public data with source links, except anything labelled [MOCK], which is fictional demo data. The supplier side is a SIMULATED sandbox agent and the salesperson files are FICTIONAL demo fixtures: say so. A SANDBOX deal is a recorded acceptance, not a signed contract.`;

// Text stays in content for hosts without MCP Apps; the explorer renders structuredContent.
const screen = (view: string, data: Record<string, unknown>) => ({ ...out(data), structuredContent: { view, data } });

const EXPLORER_URI = "ui://arsenal/explorer";
const explorer = { _meta: { ui: { resourceUri: EXPLORER_URI } } };

const server = new McpServer({ name: "arsenal-ai", version: "0.2.0" }, { instructions: INSTRUCTIONS });

registerAppResource(server, "Arsenal explorer", EXPLORER_URI, { description: "Browse Arsenal events, companies, missions, deals and tenders." }, async () => ({
  contents: [{
    uri: EXPLORER_URI, mimeType: RESOURCE_MIME_TYPE,
    text: await readFile(new URL("../dist/ui/index.html", import.meta.url), "utf8"), // Built by `pnpm --filter @salespatriot/mcp build`.
    _meta: { ui: { csp: { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] } } },
  }],
}));

registerAppTool(server, "arsenal_list_events", { description: "List events known to Arsenal AI with research status, exhibitor counts and monitoring state.", inputSchema: {}, ...explorer }, async () => { try { return screen("events", { events: await call("/events") }); } catch (e) { return fail(e); } });
server.registerTool("arsenal_add_event", { description: "Add an event by its OFFICIAL website URL and start the backend research workflow.", inputSchema: { url: z.string().url() } }, async ({ url }) => { try { return out(await call("/events", { url })); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_event_detail", { description: "Event overview, sources, tasks, updates, stats and the first page of exhibitors.", inputSchema: { eventId: z.number().int() }, ...explorer }, async ({ eventId }) => { try { const [detail, exhibitors] = await Promise.all([call(`/events/${eventId}`), call(`/events/${eventId}/exhibitors`)]); return screen("event", { detail, exhibitors }); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_search", { description: "Full-text search over events, companies and procurement notices.", inputSchema: { query: z.string().min(2) }, ...explorer }, async ({ query }) => { try { return screen("search", { query, hits: await call(`/search?q=${encodeURIComponent(query)}`) }); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_company", { description: "Full company profile with identifiers, capabilities and source evidence.", inputSchema: { companyId: z.number().int() }, ...explorer }, async ({ companyId }) => { try { return screen("company", { detail: await call(`/companies/${companyId}`) }); } catch (e) { return fail(e); } });
server.registerTool("arsenal_list_tasks", { description: "Recent agent tasks and their status/errors.", inputSchema: {} }, async () => { try { return out(await call("/tasks?limit=30")); } catch (e) { return fail(e); } });
server.registerTool("arsenal_import_exhibitors", {
  description: "Return exhibitors you found by browsing an OFFICIAL, publicly accessible exhibitor directory (e.g. a JavaScript-rendered list the backend cannot fetch). Each entry needs an evidence passage copied from the page. Never include invented exhibitors; do not bypass logins or CAPTCHAs.",
  inputSchema: {
    eventId: z.number().int(), sourceUrl: z.string().url().describe("URL of the page the list was read from"),
    exhibitors: z.array(z.object({ name: z.string(), country: z.string().optional(), website: z.string().optional(), booth: z.string().optional(), description: z.string().optional(), evidence: z.string().describe("Exact text from the page that shows this exhibitor") })).min(1).max(1000),
  },
}, async ({ eventId, sourceUrl, exhibitors }) => { try { return out(await call(`/events/${eventId}/exhibitors/import`, { collectionMethod: "MCP_TOOL", sourceUrl, exhibitors })); } catch (e) { return fail(e); } });

// ---- Missions: run the three demo scenarios from an MCP client --------------------------------------------------
// Same endpoints as Mission Control. Missions run in the backend worker; poll arsenal_mission until the status changes.
type Row = Record<string, unknown>;
const pick = (o: unknown, keys: string[]): Row => Object.fromEntries(keys.filter((k) => (o as Row | null)?.[k] !== undefined).map((k) => [k, (o as Row)[k]]));
/** Mission detail trimmed to what a chat needs; `full` returns the raw API response. */
function missionSummary(d: Row): Row {
  const m = d.mission as Row;
  const field = d.field as Row | null;
  const deal = d.deal as Row | null;
  return {
    mission: pick(m, ["id", "kind", "status", "prompt", "error", "event_id", "target_company_id", "created_at", "updated_at"]),
    request: m.parsed,
    eventRanking: ((m.ranking as Row[]) ?? []).map((r) => pick(r, ["eventId", "name", "startDate", "matching", "fitsDeadline", "examples"])),
    standsToVisit: ((m.plan as Row[]) ?? []).map((p) => pick(p, ["companyId", "name", "booth", "country", "score", "evidence", "profileUrl"])),
    steps: ((d.steps as Row[]) ?? []).filter((s) => s.kind !== "think").map((s) => `${String(s.status)} · ${String(s.title)}`),
    reasoning: ((d.steps as Row[]) ?? []).filter((s) => s.kind === "think").map((s) => ({ topic: s.title, ...pick(s.detail, ["text", "by"]) })),
    salesperson: field ? { ...pick(field, ["status", "fixture", "token"]), extracted: ((field.attachments as Row[]) ?? []).map((a) => pick(a, ["filename", "kind", "extraction_status", "extracted"])), briefing: field.briefing } : null,
    negotiation: d.negotiation ?? null,
    offers: ((d.offers as Row[]) ?? []).map((o) => ({ ...pick(o, ["version", "kind", "status", "origin"]), ...pick(o.terms, ["unitPrice", "currency", "quantity", "leadTimeDays", "paymentTerms", "deliveryTerms"]) })),
    deal: deal ? { ...pick(deal, ["id", "deal_ref", "mode", "status", "total_value", "currency", "humanApprovals", "pendingApprovals"]), pdf: `${BASE}/api/deals/${String(deal.id)}/pdf (needs the API token)` } : null,
    mailbox: d.mailpitUrl ?? null,
  };
}

registerAppTool(server, "arsenal_demo_setup", { description: "Check the demo is ready to run: buyer company, mandates (default = thermal cameras, drone), salesperson, events, and whether SMTP/Mailpit/vision/LLM are configured. Call this first.", inputSchema: {}, ...explorer }, async () => { try { return screen("setup", (await call("/demo/setup")) as Row); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_demo_prompts", { description: "Ready-made prompts: sourcing prompts (Scenario 1) and pre-event prompts (meet a supplier's agent before the event).", inputSchema: {}, ...explorer }, async () => { try { return screen("prompts", { sourcing: await call("/demo/suggestions"), preEvent: await call("/demo/suggestions-preevent") }); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_start_mission", {
  description: "Start a mission. Scenario 1 (sourcing): give `prompt`, e.g. \"Find me events where I can source 200 thermal cameras by Q1.\" Pre-event: give `prompt` and `preEvent: true`. Scenario 2 (salesperson at the event): give `field` with an event and an exhibitor's companyId from arsenal_event_exhibitors. Returns the mission id; then poll arsenal_mission.",
  inputSchema: {
    prompt: z.string().min(8).max(400).optional(),
    preEvent: z.boolean().optional().describe("Pre-event scenario: agents agree a booth meeting by email before the event"),
    field: z.object({ eventId: z.number().int(), targetCompanyId: z.number().int(), standHint: z.string().optional(), quantity: z.number().positive().optional(), profile: z.enum(["default", "drone"]).optional().describe("Mandate profile: default = thermal cameras") }).optional(),
  },
  ...explorer,
}, async ({ prompt, preEvent, field }) => { try { const r = (await call("/missions", { prompt, field, preevent: preEvent ? {} : undefined })) as { id: number }; return { ...screen("mission", missionSummary((await call(`/missions/${r.id}`)) as Row)), ...out(r) }; } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_mission", { description: "Mission status and results: event ranking, stands to visit, steps, what was read from the salesperson's photo/spec, the agents' offers and the deal. Statuses include RUNNING, WAITING_REPLY (waiting for the salesperson), MEETING_PLANNED (pre-event), NEGOTIATING, DEAL_CLOSED, FAILED.", inputSchema: { missionId: z.number().int(), full: z.boolean().optional().describe("Return the raw API response") }, ...explorer }, async ({ missionId, full }) => { try { const d = (await call(`/missions/${missionId}`)) as Row; const summary = missionSummary(d); return { ...screen("mission", summary), ...(full ? out(d) : {}) }; } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_list_missions", { description: "Recent (not archived) missions with their status.", inputSchema: {}, ...explorer }, async () => { try { return screen("missions", { missions: await call("/missions") }); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_mission_emails", { description: "The mission's real emails from the local mailbox (agent ↔ salesperson, buyer agent ↔ supplier agent). Give messageId to read one email in full.", inputSchema: { missionId: z.number().int(), messageId: z.string().optional() }, ...explorer }, async ({ missionId, messageId }) => { try { return messageId ? screen("email", { missionId, ...(await call(`/missions/${missionId}/emails/${encodeURIComponent(messageId)}`)) as Row }) : screen("emails", { missionId, ...(await call(`/missions/${missionId}/emails`)) as Row }); } catch (e) { return fail(e); } });
server.registerTool("arsenal_salesperson_reply", { description: "Play the salesperson: reply to the agent's email with the prepared demo files (flyer photo, spec, presentation, booth transcript) for a mission in WAITING_REPLY. The files are FICTIONAL, watermarked fixtures (thermal = Demo Optronics TI-640, drone = Demo Aerospace SK-4).", inputSchema: { missionId: z.number().int(), set: z.enum(["thermal", "drone"]).default("thermal"), note: z.string().max(1000).optional().describe("The salesperson's message text") } }, async ({ missionId, set, note }) => { try { return out(await call(`/missions/${missionId}/rep-reply`, { useDemoAssets: true, set, note: note ?? "" })); } catch (e) { return fail(e); } });
server.registerTool("arsenal_continue_at_event", { description: "After a pre-event mission reaches MEETING_PLANNED: hand over to the salesperson at the event (starts a new field mission with the checklist of what could only be learned on site).", inputSchema: { missionId: z.number().int() } }, async ({ missionId }) => { try { return out(await call(`/missions/${missionId}/continue-at-event`, {})); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_event_exhibitors", { description: "Exhibitors of an event, with booth and company_id (use company_id as field.targetCompanyId in arsenal_start_mission).", inputSchema: { eventId: z.number().int(), query: z.string().optional().describe("Filter by exhibitor name"), limit: z.number().int().min(1).max(200).default(25), offset: z.number().int().min(0).optional() }, ...explorer }, async ({ eventId, query, limit, offset }) => { try { const qs = new URLSearchParams({ limit: String(limit), offset: String(offset ?? 0), ...(query ? { q: query } : {}) }); return screen("exhibitors", { eventId, ...(await call(`/events/${eventId}/exhibitors?${qs.toString()}`)) as Row }); } catch (e) { return fail(e); } });
registerAppTool(server, "arsenal_deal", { description: "A closed deal: terms, offers, audit trail and human approvals (SANDBOX deals are simulations, not contracts).", inputSchema: { dealId: z.number().int() }, ...explorer }, async ({ dealId }) => { try { return screen("deal", (await call(`/deals/${dealId}`)) as Row); } catch (e) { return fail(e); } });
server.registerTool("arsenal_archive_missions", { description: "Hide all earlier missions from the start screen before a fresh demo run. Nothing is deleted.", inputSchema: {} }, async () => { try { return out(await call("/missions/archive-all", {})); } catch (e) { return fail(e); } });

const FINAL = new Set(["WAITING_REPLY", "MEETING_PLANNED", "DEAL_CLOSED", "FAILED"]);
registerAppTool(server, "arsenal_wait_mission", { description: "Wait (up to `seconds`) for the mission to move on from its current status to a point where the user is needed or it is finished: WAITING_REPLY, MEETING_PLANNED, DEAL_CLOSED or FAILED. Call it right after starting a mission or after the salesperson replies. Use this instead of sleeping. Returns the mission summary.", inputSchema: { missionId: z.number().int(), seconds: z.number().int().min(5).max(120).default(90) }, ...explorer }, async ({ missionId, seconds }) => {
  try {
    const until = Date.now() + seconds * 1000;
    const status = (x: Row) => String((x.mission as Row).status);
    let d = (await call(`/missions/${missionId}`)) as Row;
    const from = status(d);
    const done = (x: Row) => status(x) === "DEAL_CLOSED" || status(x) === "FAILED" || (status(x) !== from && FINAL.has(status(x)));
    while (!done(d) && Date.now() < until) { await new Promise((r) => setTimeout(r, 2000)); d = (await call(`/missions/${missionId}`)) as Row; }
    return screen("mission", { waited: done(d) ? `moved from ${from} to ${status(d)}` : `no stop point within ${seconds}s (status ${status(d)}); call again`, ...missionSummary(d) });
  } catch (e) { return fail(e); }
});
server.registerTool("arsenal_set_mandate", {
  description: "Change the buyer's limits the agents must respect: max unit price, max lead time, allowed payment terms. Profile default = thermal cameras, drone = drones. Only the given fields change. The simulated supplier's limits stay as configured.",
  inputSchema: { profile: z.enum(["default", "drone"]).default("default"), maxUnitPrice: z.number().positive().optional(), maxLeadTimeDays: z.number().int().positive().optional(), allowedPaymentTerms: z.string().optional().describe("Comma list, e.g. net30,net45") },
}, async ({ profile, maxUnitPrice, maxLeadTimeDays, allowedPaymentTerms }) => {
  try {
    const s = (await call("/demo/setup")) as { company: Row | null; mandates: Record<string, { buyer: Row; supplier: Row } | undefined>; rep: Row | null; deliveryLocation: string | null };
    const m = s.mandates[profile];
    if (!s.company || !s.rep || !m) return fail(new Error(`Setup for "${profile}" is incomplete; save it once in Mission Control → Setup.`));
    const buyer = { ...m.buyer, ...(maxUnitPrice ? { max_unit_price: maxUnitPrice, opening_unit_price: Math.round(maxUnitPrice * 0.8) } : {}), ...(maxLeadTimeDays ? { max_lead_time_days: maxLeadTimeDays } : {}), ...(allowedPaymentTerms ? { allowed_payment_terms: allowedPaymentTerms } : {}) };
    await call("/demo/setup", { profile, buyer: { legalName: s.company.name, country: s.company.country, website: s.company.website ?? undefined }, deliveryLocation: s.deliveryLocation ?? undefined, rep: { name: s.rep.name, email: s.rep.email }, buyerMandate: buyer, supplierMandate: m.supplier }, "PUT");
    return out({ ok: true, profile, buyerMandate: buyer });
  } catch (e) { return fail(e); }
});
registerAppTool(server, "arsenal_find_tenders", { description: "Search real public tenders and awards (TED, e-Zamówienia) in the Arsenal database. Each result has a source_url to the official notice.", inputSchema: { query: z.string().optional().describe("Words in title/description/authority"), cpv: z.string().optional().describe("CPV prefix, e.g. 35613 for drones"), country: z.string().length(2).optional(), openOnly: z.boolean().default(true), limit: z.number().int().min(1).max(50).default(10) }, ...explorer }, async ({ query, cpv, country, openOnly, limit }) => {
  try {
    const q = new URLSearchParams({ limit: String(limit), ...(query ? { q: query } : {}), ...(cpv ? { cpv } : {}), ...(country ? { country: country.toUpperCase() } : {}), ...(openOnly ? { open: "1", demand: "CONFIRMED_DEMAND" } : {}) });
    const r = (await call(`/procurement?${q.toString()}`)) as { total: number; rows: Row[] };
    return screen("tenders", { query: query ?? null, total: r.total, rows: r.rows.map((n) => pick(n, ["id", "title", "contracting_authority", "country", "deadline", "estimated_value", "currency", "cpv_codes", "procurement_status", "source_key", "source_url"])) });
  } catch (e) { return fail(e); }
});

server.registerPrompt("source_product", { title: "Source a product at a defence event", description: "Run a full sourcing mission with your agent", argsSchema: { request: z.string().describe("e.g. 200 thermal cameras by Q1") } }, ({ request }) => ({
  messages: [{ role: "user", content: { type: "text", text: `Act as my buyer's agent in Arsenal AI. I need: ${request}. Show me my current limits first and ask if I want to change them. Then find the right event, tell me which stands to visit and why, and take it all the way to a deal. Ask me before playing the salesperson.` } }],
}));

await server.connect(new StdioServerTransport());
