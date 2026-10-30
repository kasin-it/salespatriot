#!/usr/bin/env node
// Arsenal AI MCP server. Lets Claude Desktop (or any MCP client) read Arsenal data and RETURN research results to the backend.
// The backend stays the source of truth: every write goes through its HTTP API with provenance and an audit entry.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.ARSENAL_API_URL ?? "http://127.0.0.1:8787";
const TOKEN = process.env.ARSENAL_API_TOKEN;

async function call(path: string, body?: unknown): Promise<unknown> {
  if (!TOKEN) throw new Error("ARSENAL_API_TOKEN is not set. Create a token in Arsenal AI → Settings.");
  const res = await fetch(`${BASE}/api${path}`, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Arsenal API ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}
const out = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });
const fail = (e: unknown) => ({ isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] });

const server = new McpServer({ name: "arsenal-ai", version: "0.1.0" });

server.registerTool("arsenal_list_events", { description: "List events known to Arsenal AI with research status, exhibitor counts and monitoring state.", inputSchema: {} }, async () => { try { return out(await call("/events")); } catch (e) { return fail(e); } });
server.registerTool("arsenal_add_event", { description: "Add an event by its OFFICIAL website URL and start the backend research workflow.", inputSchema: { url: z.string().url() } }, async ({ url }) => { try { return out(await call("/events", { url })); } catch (e) { return fail(e); } });
server.registerTool("arsenal_event_detail", { description: "Event overview, sources, tasks, updates and stats.", inputSchema: { eventId: z.number().int() } }, async ({ eventId }) => { try { return out(await call(`/events/${eventId}`)); } catch (e) { return fail(e); } });
server.registerTool("arsenal_search", { description: "Full-text search over events, companies and procurement notices.", inputSchema: { query: z.string().min(2) } }, async ({ query }) => { try { return out(await call(`/search?q=${encodeURIComponent(query)}`)); } catch (e) { return fail(e); } });
server.registerTool("arsenal_company", { description: "Full company profile with identifiers, capabilities and source evidence.", inputSchema: { companyId: z.number().int() } }, async ({ companyId }) => { try { return out(await call(`/companies/${companyId}`)); } catch (e) { return fail(e); } });
server.registerTool("arsenal_list_tasks", { description: "Recent agent tasks and their status/errors.", inputSchema: {} }, async () => { try { return out(await call("/tasks?limit=30")); } catch (e) { return fail(e); } });
server.registerTool("arsenal_import_exhibitors", {
  description: "Return exhibitors you found by browsing an OFFICIAL, publicly accessible exhibitor directory (e.g. a JavaScript-rendered list the backend cannot fetch). Each entry needs an evidence passage copied from the page. Never include invented exhibitors; do not bypass logins or CAPTCHAs.",
  inputSchema: {
    eventId: z.number().int(), sourceUrl: z.string().url().describe("URL of the page the list was read from"),
    exhibitors: z.array(z.object({ name: z.string(), country: z.string().optional(), website: z.string().optional(), booth: z.string().optional(), description: z.string().optional(), evidence: z.string().describe("Exact text from the page that shows this exhibitor") })).min(1).max(1000),
  },
}, async ({ eventId, sourceUrl, exhibitors }) => { try { return out(await call(`/events/${eventId}/exhibitors/import`, { collectionMethod: "MCP_TOOL", sourceUrl, exhibitors })); } catch (e) { return fail(e); } });

await server.connect(new StdioServerTransport());
