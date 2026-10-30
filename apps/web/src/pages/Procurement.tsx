import { useState } from "react";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Err, ExtLink, Field, Stat, Table, Unknown, fmtDate, fmtTime, parseList } from "../ui.tsx";
import type { Row } from "../types.ts";

const SOURCE_LABEL: Record<string, string> = { ted: "TED — Official API", ezamowienia: "e-Zamówienia — Official API", manual: "Manually imported" };

export function Procurement() {
  const [f, setF] = useState({ q: "", source: "", demand: "", authority: "", category: "", open: false });
  const qs = new URLSearchParams({ limit: "50", ...(f.q && { q: f.q }), ...(f.source && { source: f.source }), ...(f.demand && { demand: f.demand }), ...(f.authority && { authority: f.authority }), ...(f.category && { category: f.category }), ...(f.open && { open: "1" }) });
  const list = useApi<Row>(`/procurement?${qs}`, 20000);
  const conns = useApi<Row[]>("/connectors", 10000);
  const auth = useApi<Row[]>("/authorities");
  const filters = useApi<Row>("/procurement-filters");
  const jobs = useApi<Row[]>("/ingestion-jobs", 10000);
  const [sel, setSel] = useState<Row | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [tedFilter, setTedFilter] = useState("defence_directive");
  const sync = async (body: Row) => { try { await api("/procurement/sync", { body }); setMsg("Sync task queued — follow it in Agent Manager."); } catch (e) { setMsg((e as Error).message); } };
  const open = async (id: number) => setSel(await api<Row>(`/procurement/${id}`));
  const proc = (conns.data ?? []).filter((c) => c.kind.startsWith("procurement"));
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-bold">Procurement Intelligence</h1><p className="text-sm text-muted">Real notices from official sources. Missing metadata stays empty. A notice is an opportunity, not proof that anyone wants to trade with you.</p></div>
      <Card title="Source coverage" actions={<Btn onClick={() => conns.reload()}>Refresh</Btn>}>
        <Table rows={proc} cols={[
          { h: "Source", r: (c) => <div><div className="font-medium">{c.name}</div><div className="text-[11px] text-muted">{c.endpoint}</div></div> }, { h: "Status", r: (c) => <Badge value={c.status} /> },
          { h: "Access", r: (c) => c.access_method }, { h: "Notices stored", r: (c) => c.records_total }, { h: "Last attempt", r: (c) => fmtTime(c.last_attempt_at) ?? "never" }, { h: "Last success", r: (c) => fmtTime(c.last_success_at) ?? "never" },
          { h: "New / updated (last run)", r: (c) => `${c.last_new} / ${c.last_updated}` }, { h: "Failed requests", r: (c) => c.failed_requests }, { h: "Rate limit", r: (c) => c.rate_limit ?? "—" },
          { h: "Known limitations", r: (c) => <div className="max-w-xs text-[11px] text-amber-200/80">{c.coverage_notes}{c.last_error && <div className="text-red-300">Last error: {c.last_error.slice(0, 120)}</div>}</div> },
        ]} />
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label="TED filter"><select value={tedFilter} onChange={(e) => setTedFilter(e.target.value)}>{(filters.data?.ted ?? []).map((t: Row) => <option key={t.key} value={t.key}>{t.label}</option>)}</select></Field>
          <Btn tone="primary" onClick={() => void sync({ source: "ted", filter: tedFilter })}>Sync TED (incremental)</Btn>
          <Btn onClick={() => void sync({ source: "ezamowienia", days: 2 })}>Sync e-Zamówienia (last 2 days)</Btn>
          {msg && <span className="text-xs text-muted">{msg}</span>}
        </div>
        <Table rows={jobs.data?.slice(0, 5) ?? []} cols={[{ h: "Job", r: (j) => `#${j.id} ${j.connector_key}` }, { h: "Status", r: (j) => <Badge value={j.status} /> }, { h: "Fetched", r: (j) => j.fetched }, { h: "New", r: (j) => j.created }, { h: "Updated", r: (j) => j.updated }, { h: "Failed", r: (j) => j.failed }, { h: "Started", r: (j) => fmtTime(j.started_at) }, { h: "Error", r: (j) => <span className="text-red-300">{j.error?.slice(0, 80)}</span> }]} />
      </Card>
      <Card title="Contracting authority mappings (via TED)">
        <Table rows={auth.data ?? []} cols={[{ h: "Authority", r: (a) => a.display_name }, { h: "Notices in database", r: (a) => <Stat label="" value={a.noticesInDatabase} /> }, { h: "Latest publication", r: (a) => fmtDate(a.lastPublication) ?? <Unknown label="none retrieved" /> }, { h: "Direct source", r: (a) => <Badge value={a.direct_source_status} tone="amber" /> }, { h: "Coverage note", r: (a) => <span className="text-[12px] text-amber-200/80">{a.coverage_note}</span> }]} />
      </Card>
      <Card title="Search notices">
        <div className="grid gap-3 md:grid-cols-6">
          <Field label="Text"><input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
          <Field label="Source"><select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}><option value="">Any</option><option value="ted">TED</option><option value="ezamowienia">e-Zamówienia</option><option value="manual">Manual</option></select></Field>
          <Field label="Authority"><select value={f.authority} onChange={(e) => setF({ ...f, authority: e.target.value })}><option value="">Any</option><option value="AGENCJA_UZBROJENIA">Agencja Uzbrojenia</option><option value="EDA">EDA</option></select></Field>
          <Field label="Demand class"><select value={f.demand} onChange={(e) => setF({ ...f, demand: e.target.value })}><option value="">Any</option><option value="CONFIRMED_DEMAND">Confirmed</option><option value="HISTORICAL_DEMAND">Historical</option></select></Field>
          <Field label="Category"><select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="">Any</option>{(filters.data?.categories ?? []).map((c: Row) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
          <label className="mt-5 flex items-center gap-2 text-xs"><input className="!w-auto" type="checkbox" checked={f.open} onChange={(e) => setF({ ...f, open: e.target.checked })} />Open only</label>
        </div>
      </Card>
      <Err msg={list.error} />
      <Card title={`Notices (${list.data?.total ?? 0})`}>
        <Table rows={list.data?.rows ?? []} onRow={(r) => void open(r.id)} empty="No notices stored. Run a sync above." cols={[
          { h: "Title / authority", r: (n) => <div className="max-w-md"><div className="font-medium">{n.title ?? <Unknown label="No title" />}</div><div className="text-[11px] text-muted">{n.contracting_authority ?? "Authority unknown"} · {n.country ?? "?"}</div></div> },
          { h: "Published", r: (n) => fmtDate(n.publication_date) ?? <Unknown /> }, { h: "Deadline", r: (n) => fmtDate(n.deadline) ?? <Unknown label="Not published" /> },
          { h: "CPV", r: (n) => { const c = parseList(n.cpv_codes); return c.length ? c.slice(0, 3).join(", ") + (c.length > 3 ? "…" : "") : <Unknown label="Not published" />; } },
          { h: "Demand", r: (n) => <Badge value={n.demand_class} /> },
          { h: "Completeness", r: (n) => `${Math.round(n.data_completeness * 100)}%` },
          { h: "Source", r: (n) => <div className="text-[11px]">{SOURCE_LABEL[n.source_key] ?? n.source_key}{parseList(n.authority_tags).length ? <div className="text-amber-200/80">Retrieved through TED (mapped: {parseList(n.authority_tags).join(", ")})</div> : null}</div> },
        ]} />
      </Card>
      {sel && (
        <Card title={`Notice ${sel.source_notice_id}`} actions={<Btn onClick={() => setSel(null)}>Close</Btn>}>
          <dl className="grid grid-cols-[170px_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-muted">Official source</dt><dd><ExtLink href={sel.source_url} /></dd><dt className="text-muted">Retrieved via</dt><dd>{sel.retrieved_via} at {fmtTime(sel.retrieval_timestamp)}</dd>
            <dt className="text-muted">Authority</dt><dd>{sel.contracting_authority ?? <Unknown />}</dd><dt className="text-muted">Description</dt><dd className="whitespace-pre-wrap">{sel.description ?? <Unknown />}</dd>
            <dt className="text-muted">Estimated value</dt><dd>{sel.estimated_value != null ? `${sel.estimated_value} ${sel.currency ?? ""}` : <Unknown label="Not published" />}</dd>
            <dt className="text-muted">Missing fields</dt><dd>{parseList(sel.missing_fields).join(", ") || "none"}</dd>
            <dt className="text-muted">Matching suppliers</dt><dd>{(sel.matches as Row[]).length ? (sel.matches as Row[]).map((m) => `${m.supplier} (${m.status}, ${m.score})`).join("; ") : <Unknown label="none" />}</dd>
          </dl>
          <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted">Original payload (audit)</summary><pre className="mt-2 max-h-72 overflow-auto rounded bg-black/40 p-2">{JSON.stringify(sel.original_payload, null, 1)}</pre></details>
        </Card>
      )}
    </div>
  );
}
