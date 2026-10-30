import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { freshDb, fixtureCompany, fixtureUser } from "../helpers.ts";
import { closeAllMcp, discoverServer, executeMcpTool, registry } from "../../src/mcp/adapter.ts";

// Real stdio MCP round trip against the project's own MCP server (no network needed for tool discovery).
test("MCP: discover tools from a real stdio server, execute through the layer, record the execution", { timeout: 60_000 }, async () => {
  const db = freshDb();
  const dir = mkdtempSync(join(tmpdir(), "arsenal-mcp-"));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify({ mcpServers: { "arsenal-self": { command: process.execPath, args: [resolve(import.meta.dirname!, "../../../mcp/src/server.ts")], env: { ARSENAL_API_URL: "http://127.0.0.1:1" } } } }));
  process.env.ARSENAL_MCP_CONFIG = cfg;
  const d = await discoverServer("arsenal-self");
  assert.equal(d.ok, true, String(d.error));
  assert.ok(d.tools >= 6);
  assert.ok(registry().some((r) => r.tool_name === "arsenal_import_exhibitors"));
  // read tool is permitted with mcp:read; the call itself fails honestly because the API is unreachable and no token is set
  const r = await executeMcpTool({ server: "arsenal-self", tool: "arsenal_list_events", input: {}, userId: null, grantedPermissions: ["mcp:read"] });
  assert.equal(r.ok, true);
  assert.match(JSON.stringify(r.output), /ARSENAL_API_TOKEN is not set/);
  const denied = await executeMcpTool({ server: "arsenal-self", tool: "arsenal_add_event", input: { url: "https://x.test" }, userId: null, grantedPermissions: ["mcp:read"] });
  assert.equal(denied.ok, false);
  assert.deepEqual(db.all<{ status: string }>("SELECT status FROM mcp_tool_executions ORDER BY id").map((x) => x.status), ["SUCCEEDED", "DENIED_PERMISSION"]);
  const bad = await discoverServer("not-configured");
  assert.equal(bad.ok, false);
  void fixtureCompany; void fixtureUser;
  delete process.env.ARSENAL_MCP_CONFIG;
  await closeAllMcp();
});
