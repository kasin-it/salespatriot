import { useState } from "react";
import { Link } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Err, ExtLink, Field, PageHead, Table, fmtDate } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Matches() {
  const [status, setStatus] = useState("");
  const { data, error } = useApi<Row>(`/matches?limit=100${status ? `&status=${status}` : ""}`, 15000);
  const [open, setOpen] = useState<Row | null>(null);
  const me = useApi<Row>("/me");
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <PageHead title="Matching Center" sub="Structured category/CPV filtering first. Scores are capped by evidence quality; a public claim never becomes a verified match." />
      <Card title="Filter"><div className="grid gap-3 md:grid-cols-4"><Field label="Match status"><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any</option>{["VERIFIED_MATCH", "POTENTIAL_MATCH", "INSUFFICIENT_INFORMATION", "INCOMPATIBLE"].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <div className="flex items-end gap-2">{(me.data?.companies ?? []).map((c: Row) => <Btn key={c.id} onClick={() => void api("/matching/run", { body: { supplierId: c.id } }).then(() => setMsg(`Matching queued for ${c.name}`))}>Re-run for {c.name}</Btn>)}{msg && <span className="text-xs text-muted">{msg}</span>}</div></div></Card>
      <Err msg={error} />
      <Card title={`Matches (${data?.total ?? 0})`}>
        <Table rows={data?.rows ?? []} onRow={(r) => setOpen(r)} empty="No matches yet. They are created when companies with evidenced capabilities meet real demand." cols={[
          { h: "Supplier", r: (m) => <Link className="text-accent underline-offset-2 hover:underline hover:text-accent" to={`/companies/${m.supplier_company_id}`} onClick={(e) => e.stopPropagation()}>{m.supplier_name}</Link> },
          { h: "Demand", r: (m) => <div className="max-w-md"><div>{m.notice_title ?? "Buyer requirement"}</div><div className="text-[11px] text-muted">{m.contracting_authority ?? ""}</div></div> },
          { h: "Status", r: (m) => <Badge value={m.status} /> }, { h: "Score", r: (m) => m.score }, { h: "Demand class", r: (m) => <Badge value={m.demand_class} /> }, { h: "Deadline", r: (m) => fmtDate(m.deadline) ?? "—" },
        ]} />
      </Card>
      {open && (
        <Card title={`Match #${open.id}`} actions={<Btn onClick={() => setOpen(null)}>Close</Btn>}>
          <p className="mb-3 text-[13px]">{open.explanation}</p>
          <div className="grid gap-4 md:grid-cols-3 text-[13px]">
            <div><h3 className="ds-cap mb-1">Supporting evidence</h3><ul className="space-y-2">{(open.evidence as Row[]).map((e, i) => <li key={i}>{e.type === "capability" ? <><Badge value={e.class} /> <span className="italic text-muted">“{e.passage}”</span> <ExtLink href={e.sourceUrl?.startsWith("http") ? e.sourceUrl : null}>source</ExtLink></> : <><Badge value="PROCUREMENT" tone="blue" /> <ExtLink href={e.sourceUrl}>{e.title ?? "notice"}</ExtLink></>}</li>)}</ul></div>
            <div><h3 className="ds-cap mb-1">Missing information</h3><ul className="list-disc pl-4 text-ink">{(open.missing_info as string[]).map((m) => <li key={m}>{m}</li>)}</ul></div>
            <div><h3 className="ds-cap mb-1">Risks</h3><ul className="list-disc pl-4 text-ink">{(open.risks as string[]).map((m) => <li key={m}>{m}</li>)}</ul><div className="mt-2 text-muted">Confidence {open.confidence}</div></div>
          </div>
        </Card>
      )}
    </div>
  );
}
