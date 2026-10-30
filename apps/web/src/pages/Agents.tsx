import { useState } from "react";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, PageHead, Table, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Agents() {
  const agents = useApi<Row[]>("/agents", 5000);
  const [status, setStatus] = useState("");
  const tasks = useApi<Row[]>(`/tasks?limit=60${status ? `&status=${status}` : ""}`, 4000);
  const approvals = useApi<Row[]>("/approvals", 8000);
  const [sel, setSel] = useState<number | null>(null);
  const detail = useApi<Row>(sel ? `/tasks/${sel}` : null, 3000);
  const [msg, setMsg] = useState<string | null>(null);
  const call = async (fn: () => Promise<unknown>) => { try { await fn(); agents.reload(); tasks.reload(); approvals.reload(); } catch (e) { setMsg((e as Error).message); } };
  return (
    <div className="space-y-5">
      <PageHead title="Agent Manager" sub="All agents share one persisted task queue. Activity below is real execution history; nothing is simulated." />
      <Err msg={agents.error ?? msg} />
      <Card title="Agents">
        <Table rows={agents.data ?? []} cols={[
          { h: "Agent", r: (a) => <div><div className="font-medium">{a.name}</div><div className="max-w-md text-[11px] text-muted">{a.description}</div></div> },
          { h: "Enabled", r: (a) => <Btn onClick={() => void call(() => api(`/agents/${a.key}`, { method: "PATCH", body: { enabled: !a.enabled } }))}>{a.enabled ? "Enabled — disable" : "Disabled — enable"}</Btn> },
          { h: "Permissions", r: (a) => <div className="flex max-w-xs flex-wrap gap-1">{a.permissions.map((p: string) => <Badge key={p} value={p} tone="blue" />)}</div> },
          { h: "Tools", r: (a) => <span className="text-[11px] text-muted">{a.tools.join(", ")}</span> },
          { h: "Queued / running / failed", r: (a) => `${a.queued} / ${a.running} / ${a.failed}` }, { h: "Last activity", r: (a) => fmtTime(a.last_activity_at) ?? "never" },
          { h: "Last error", r: (a) => <span className="text-[11px] text-alert">{a.lastError?.slice(0, 80)}</span> },
        ]} />
      </Card>
      <Card title="Pending approvals">
        <Table rows={(approvals.data ?? []).filter((a) => a.status === "PENDING")} empty="Nothing waiting for a human decision." cols={[
          { h: "#", r: (a) => a.id }, { h: "Action", r: (a) => a.action }, { h: "Why approval is needed", r: (a) => <span className="font-medium">{a.reason}</span> }, { h: "Requested by", r: (a) => a.requested_by },
          { h: "", r: (a) => <div className="flex gap-1"><Btn tone="primary" onClick={() => void call(() => api(`/approvals/${a.id}/decide`, { body: { approve: true } }))}>Approve</Btn><Btn tone="danger" onClick={() => void call(() => api(`/approvals/${a.id}/decide`, { body: { approve: false } }))}>Reject</Btn></div> },
        ]} />
      </Card>
      <Card title="Tasks" actions={<select className="!w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "RETRY_SCHEDULED", "WAITING_APPROVAL", "CANCELLED"].map((s) => <option key={s}>{s}</option>)}</select>}>
        <Table rows={tasks.data ?? []} onRow={(t) => setSel(t.id)} empty="No tasks yet." cols={[
          { h: "#", r: (t) => t.id }, { h: "Agent", r: (t) => t.agent_key }, { h: "Type", r: (t) => t.type }, { h: "Status", r: (t) => <Badge value={t.status} /> },
          { h: "Progress / error", r: (t) => <span className={`block max-w-md truncate ${t.error ? "text-alert" : "text-muted"}`}>{t.error ?? t.progress_note ?? ""}</span> }, { h: "Attempts", r: (t) => `${t.attempts}/${t.max_attempts}` },
          { h: "By", r: (t) => <span className="text-[11px]">{t.created_by}</span> }, { h: "Created", r: (t) => fmtTime(t.created_at) },
          { h: "", r: (t) => <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>{["QUEUED", "RUNNING", "RETRY_SCHEDULED", "WAITING_APPROVAL"].includes(t.status) && <Btn tone="danger" onClick={() => void call(() => api(`/tasks/${t.id}/cancel`, { body: {} }))}>Cancel</Btn>}{["FAILED", "CANCELLED"].includes(t.status) && <Btn onClick={() => void call(() => api(`/tasks/${t.id}/retry`, { body: {} }))}>Retry</Btn>}</div> },
        ]} />
      </Card>
      {sel && detail.data && (
        <Card title={`Task #${sel} — ${detail.data.task.type}`} actions={<Btn onClick={() => setSel(null)}>Close</Btn>}>
          <div className="grid gap-4 lg:grid-cols-2 text-[12px]">
            <div><h3 className="ds-cap mb-1">Executions</h3><Table rows={detail.data.executions} cols={[{ h: "Attempt", r: (x) => x.attempt }, { h: "Status", r: (x) => <Badge value={x.status} /> }, { h: "Started", r: (x) => fmtTime(x.started_at) }, { h: "Error", r: (x) => <span className="text-alert">{x.error}</span> }]} />
              <h3 className="ds-cap mb-1 mt-3">Actions</h3>{detail.data.actions.length ? <ul>{detail.data.actions.map((a: Row) => <li key={a.id}>{fmtTime(a.created_at)} — {a.action} {a.detail}</li>)}</ul> : <Empty>No actions recorded.</Empty>}
              <h3 className="ds-cap mb-1 mt-3">Result</h3><pre className="max-h-48 overflow-auto bg-mist p-2">{JSON.stringify(detail.data.task.result, null, 1)}</pre></div>
            <div><h3 className="ds-cap mb-1">Sources retrieved</h3><Table rows={detail.data.scrapes} empty="No web requests by this task." cols={[{ h: "URL", r: (s) => <span className="block max-w-xs truncate">{s.url}</span> }, { h: "Status", r: (s) => <Badge value={s.status} /> }, { h: "HTTP", r: (s) => s.http_status ?? "—" }, { h: "ms", r: (s) => s.duration_ms ?? "—" }, { h: "Cache", r: (s) => (s.from_cache ? "yes" : "") }]} /></div>
          </div>
        </Card>
      )}
    </div>
  );
}
