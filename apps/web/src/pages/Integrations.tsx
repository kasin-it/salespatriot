import { useState } from "react";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Err, PageHead, Table, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Integrations() {
  const conns = useApi<Row[]>("/connectors", 10000);
  const mcp = useApi<Row>("/mcp/registry", 10000);
  const execs = useApi<Row[]>("/mcp/executions", 10000);
  const [msg, setMsg] = useState<string | null>(null);
  const discover = async (s: string) => { const r = await api<Row>(`/mcp/discover/${s}`, { body: {} }); setMsg(r.ok ? `${s}: ${r.tools} tools discovered` : `${s}: ${r.error}`); mcp.reload(); };
  const servers = [...new Set(((mcp.data?.registry ?? []) as Row[]).map((r) => r.server))];
  return (
    <div className="space-y-5">
      <PageHead title="Integrations" sub="Connector and MCP status as actually observed. Unconfigured or unreachable integrations are reported as such." />
      <Card title="Data connectors">
        <Table rows={conns.data ?? []} cols={[{ h: "Connector", r: (c) => <div><div className="font-medium">{c.name}</div><div className="text-[11px] text-muted">{c.endpoint}</div></div> }, { h: "Status", r: (c) => <Badge value={c.status} /> }, { h: "Access", r: (c) => c.access_method }, { h: "Records", r: (c) => c.records_total }, { h: "Last success", r: (c) => fmtTime(c.last_success_at) ?? "never" }, { h: "Notes", r: (c) => <span className="block max-w-sm text-[11px] text-muted">{c.coverage_notes}{c.last_error && <span className="text-alert"> — {c.last_error.slice(0, 100)}</span>}</span> }]} />
      </Card>
      <Card title="MCP tool registry" actions={msg ? <span className="text-xs text-muted">{msg}</span> : null}>
        <p className="mb-3 text-[12px] text-muted">Configuration file: {mcp.data?.configPath}. Servers configured: {(mcp.data?.configuredServers ?? []).join(", ") || "none"}. Set <code>ARSENAL_MCP_CONFIG</code> to a Claude-Desktop-style JSON file (see README). The backend does not depend on Claude Desktop being open.</p>
        <Err msg={mcp.error} />
        {servers.map((s) => { const rows = ((mcp.data?.registry ?? []) as Row[]).filter((r) => r.server === s); return (
          <div key={s} className="mb-4"><div className="mb-1 flex items-center gap-2"><b>{s}</b><Badge value={rows[0]?.status} />{rows[0]?.last_error && <span className="text-xs text-alert">{rows[0].last_error.slice(0, 120)}</span>}<Btn onClick={() => void discover(s)}>Discover tools</Btn></div>
            <Table rows={rows.filter((r) => r.tool_name)} empty="No tools discovered yet." cols={[{ h: "Tool", r: (r) => r.tool_name }, { h: "Description", r: (r) => <span className="text-[11px] text-muted">{r.description}</span> }, { h: "Permission", r: (r) => <Badge value={r.permission_required} tone="blue" /> }, { h: "Status", r: (r) => <Badge value={r.tool_status} /> }, { h: "Last success", r: (r) => fmtTime(r.last_success_at) ?? "never" }]} /></div>); })}
        {!servers.length && <div className="text-sm text-muted">No MCP servers configured on this backend.</div>}
      </Card>
      <Card title="MCP tool executions (audit)"><Table rows={execs.data ?? []} empty="No tool has been executed." cols={[{ h: "When", r: (e) => fmtTime(e.executed_at) }, { h: "Tool", r: (e) => `${e.server_name}/${e.tool_name}` }, { h: "Authorised", r: (e) => (e.authorized ? "yes" : "no") }, { h: "Status", r: (e) => <Badge value={e.status} /> }, { h: "Error", r: (e) => <span className="text-alert">{e.error}</span> }]} /></Card>
    </div>
  );
}
