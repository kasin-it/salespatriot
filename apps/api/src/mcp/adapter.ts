import { readFileSync, existsSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { errorMessage, now } from "../lib/util.ts";

/** Provider-independent MCP integration surface. */
export interface McpAdapter {
  provider: string;
  discoverTools(): Promise<DiscoveredTool[]>;
  executeTool(name: string, input: Record<string, unknown>): Promise<unknown>;
  getToolStatus(name: string): { status: string; lastSuccessAt: string | null; lastError: string | null };
  getPermissions(name: string): string;
  close(): Promise<void>;
}

export interface DiscoveredTool { name: string; description?: string; inputSchema?: unknown; outputSchema?: unknown }

interface ServerConfig { command: string; args?: string[]; env?: Record<string, string> }

/** Server definitions come from a Claude-Desktop-style JSON file (ARSENAL_MCP_CONFIG). Secrets stay in that file / the environment, never in code, DB or the model context. */
export function loadMcpConfig(): Record<string, ServerConfig> {
  const path = process.env.ARSENAL_MCP_CONFIG;
  if (!path || !existsSync(path)) return {};
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { mcpServers?: Record<string, ServerConfig> }).mcpServers ?? {};
  } catch {
    return {};
  }
}

const READ_ONLY = /(^|_)(get|list|read|search|fetch|query|describe|screenshot|snapshot|find|extract|detail|status)(_|$)/i;
/** Permission needed per tool: reads are 'mcp:read', everything else 'mcp:act'. Unknown names default to the stricter class. */
export const permissionFor = (tool: string): string => (READ_ONLY.test(tool) ? "mcp:read" : "mcp:act");

/** Only the variables a server needs: the parent environment minus the test runner's marker, plus the server's own configured values. */
function childEnv(extra?: Record<string, string>): Record<string, string> {
  const env = { ...(process.env as Record<string, string>) };
  delete env.NODE_TEST_CONTEXT;
  return { ...env, ...extra };
}

class StdioAdapter implements McpAdapter {
  provider: string;
  private client: Client | null = null;
  private cfg: ServerConfig;
  constructor(provider: string, cfg: ServerConfig) {
    this.provider = provider;
    this.cfg = cfg;
  }
  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const c = new Client({ name: "arsenal-ai", version: "0.1.0" });
    await c.connect(new StdioClientTransport({ command: this.cfg.command, args: this.cfg.args, env: childEnv(this.cfg.env), stderr: "ignore" }));
    this.client = c;
    return c;
  }
  async discoverTools(): Promise<DiscoveredTool[]> {
    const c = await this.connect();
    const r = await c.listTools();
    return r.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, outputSchema: (t as { outputSchema?: unknown }).outputSchema }));
  }
  async executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
    const c = await this.connect();
    return c.callTool({ name, arguments: input });
  }
  getToolStatus(name: string) {
    const r = getDb().get<{ status: string; last_success_at: string | null; last_error: string | null }>(
      "SELECT t.status, t.last_success_at, t.last_error FROM mcp_tools t JOIN mcp_servers s ON s.id=t.server_id WHERE s.name=? AND t.tool_name=?", this.provider, name);
    return { status: r?.status ?? "UNKNOWN", lastSuccessAt: r?.last_success_at ?? null, lastError: r?.last_error ?? null };
  }
  getPermissions = permissionFor;
  async close() {
    await this.client?.close().catch(() => {});
    this.client = null;
  }
}

const adapters = new Map<string, McpAdapter>();

export function syncConfiguredServers(): string[] {
  const db = getDb();
  const cfg = loadMcpConfig();
  for (const [name, c] of Object.entries(cfg)) {
    db.run(`INSERT INTO mcp_servers (name, provider, transport, command, args, config_origin, status) VALUES (?, ?, 'stdio', ?, ?, 'ARSENAL_MCP_CONFIG', 'UNVERIFIED')
            ON CONFLICT(name) DO UPDATE SET command=excluded.command, args=excluded.args`, name, name, c.command, JSON.stringify(c.args ?? []));
  }
  return Object.keys(cfg);
}

export async function closeAllMcp(): Promise<void> {
  await Promise.all([...adapters.values()].map((a) => a.close()));
  adapters.clear();
}

function adapterFor(name: string): McpAdapter {
  let a = adapters.get(name);
  if (!a) {
    const cfg = loadMcpConfig()[name];
    if (!cfg) throw new Error(`MCP server "${name}" is not configured (set ARSENAL_MCP_CONFIG)`);
    a = new StdioAdapter(name, cfg);
    adapters.set(name, a);
  }
  return a;
}

/** Connect to a configured server and persist its real tool list. Failures are stored and reported, never hidden. */
export async function discoverServer(name: string): Promise<{ ok: boolean; tools: number; error?: string }> {
  const db = getDb();
  syncConfiguredServers();
  const s = db.get<{ id: number }>("SELECT id FROM mcp_servers WHERE name=?", name);
  if (!s) return { ok: false, tools: 0, error: "Server not configured" };
  try {
    const tools = await adapterFor(name).discoverTools();
    for (const t of tools) {
      db.run(`INSERT INTO mcp_tools (server_id, tool_name, description, input_schema, output_schema, permission_required, status) VALUES (?,?,?,?,?,?, 'AVAILABLE')
              ON CONFLICT(server_id, tool_name) DO UPDATE SET description=excluded.description, input_schema=excluded.input_schema, output_schema=excluded.output_schema, status='AVAILABLE', last_error=NULL`,
        s.id, t.name, t.description ?? null, JSON.stringify(t.inputSchema ?? null), JSON.stringify(t.outputSchema ?? null), permissionFor(t.name));
    }
    db.update("mcp_servers", s.id, { status: "CONNECTED", last_error: null, last_discovered_at: now() });
    return { ok: true, tools: tools.length };
  } catch (e) {
    const msg = errorMessage(e);
    db.update("mcp_servers", s.id, { status: "ERROR", last_error: msg });
    db.run("UPDATE mcp_tools SET status='UNAVAILABLE', last_error=? WHERE server_id=?", msg, s.id);
    adapters.delete(name);
    return { ok: false, tools: 0, error: msg };
  }
}

export interface ExecuteArgs { server: string; tool: string; input: Record<string, unknown>; userId: number | null; taskId?: number; grantedPermissions: string[] }

/** Every execution — allowed, denied or failed — is recorded with input, status and error. */
export async function executeMcpTool(a: ExecuteArgs): Promise<{ ok: boolean; output?: unknown; error?: string }> {
  const db = getDb();
  const toolRow = db.get<{ id: number; permission_required: string }>("SELECT t.id, t.permission_required FROM mcp_tools t JOIN mcp_servers s ON s.id=t.server_id WHERE s.name=? AND t.tool_name=?", a.server, a.tool);
  const needed = toolRow?.permission_required ?? permissionFor(a.tool);
  const log = (status: string, extra: { out?: string; err?: string; ms?: number; authorized: boolean }) =>
    db.insert("mcp_tool_executions", { tool_id: toolRow?.id ?? null, server_name: a.server, tool_name: a.tool, user_id: a.userId, task_id: a.taskId ?? null, authorized: extra.authorized ? 1 : 0, input: JSON.stringify(a.input).slice(0, 4000), status: status, output_excerpt: extra.out?.slice(0, 2000) ?? null, error: extra.err ?? null, duration_ms: extra.ms ?? null });
  if (!toolRow) { log("DENIED_UNKNOWN_TOOL", { authorized: false, err: "Tool not in registry; run discovery first" }); return { ok: false, error: "Tool is not in the registry. Discover the server's tools first." }; }
  if (!a.grantedPermissions.includes(needed) && !a.grantedPermissions.includes("mcp:act")) { log("DENIED_PERMISSION", { authorized: false, err: `Requires ${needed}` }); return { ok: false, error: `Permission ${needed} required` }; }
  const started = Date.now();
  try {
    const out = await adapterFor(a.server).executeTool(a.tool, a.input);
    const text = JSON.stringify(out);
    db.run("UPDATE mcp_tools SET last_success_at=?, status='AVAILABLE', last_error=NULL WHERE id=?", now(), toolRow.id);
    log("SUCCEEDED", { authorized: true, out: text, ms: Date.now() - started });
    audit({ actorType: "mcp", actorId: a.server, action: "mcp.executed", entityType: "mcp_tool", entityId: toolRow.id, summary: `${a.server}/${a.tool} succeeded` });
    return { ok: true, output: out };
  } catch (e) {
    const msg = errorMessage(e);
    db.run("UPDATE mcp_tools SET last_error=?, status='ERROR' WHERE id=?", msg, toolRow.id);
    log("FAILED", { authorized: true, err: msg, ms: Date.now() - started });
    return { ok: false, error: msg };
  }
}

export function registry() {
  const db = getDb();
  return db.all<{ server: string; status: string; last_error: string | null; tool_name: string | null; description: string | null; permission_required: string | null; tool_status: string | null; last_success_at: string | null; input_schema: string | null }>(
    `SELECT s.name server, s.status, s.last_error, t.tool_name, t.description, t.permission_required, t.status tool_status, t.last_success_at, t.input_schema FROM mcp_servers s LEFT JOIN mcp_tools t ON t.server_id=s.id ORDER BY s.name, t.tool_name`)
    .map((r) => ({ ...r, input_schema: json(r.input_schema, null) }));
}
