import { useState } from "react";
import { useApi } from "../api.ts";
import { Badge, Card, Empty, Stat, Table, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Deals() {
  const deals = useApi<Row[]>("/deals", 10000);
  const analytics = useApi<Row>("/analytics/events");
  const [sel, setSel] = useState<number | null>(null);
  const detail = useApi<Row>(sel ? `/deals/${sel}` : null);
  const real = (deals.data ?? []).filter((d) => d.mode === "REAL");
  const sandbox = (deals.data ?? []).filter((d) => d.mode === "SANDBOX");
  const value = real.reduce((a, d) => a + (d.total_value ?? 0), 0);
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-bold">Deal Room</h1><p className="text-sm text-muted">An accepted offer is recorded here with its audit trail. It is not a signed contract, and delivery/payment are not tracked.</p></div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Real deals accepted" value={real.length} sub="Accepted value (not completed): see table" /><Stat label="Accepted value (real)" value={real.length ? value.toLocaleString() : "—"} sub="Mixed currencies are not summed across currencies in reports" />
        <Stat label="Sandbox deals" value={sandbox.length} sub="Simulations — never counted as business" /><Stat label="Completed transactions" value="Unknown" sub="Fulfilment is not tracked" />
      </div>
      <Card title="Deals">
        <Table rows={deals.data ?? []} onRow={(d) => setSel(d.id)} empty="No deals recorded. A deal exists only after both parties accepted the same offer version." cols={[
          { h: "Ref", r: (d) => d.deal_ref }, { h: "Mode", r: (d) => <Badge value={d.mode} /> }, { h: "Buyer → Supplier", r: (d) => `${d.buyer_name} → ${d.supplier_name}` }, { h: "Subject", r: (d) => d.subject },
          { h: "Value", r: (d) => (d.total_value != null ? `${d.total_value} ${d.currency}` : "Unknown") }, { h: "Origin event", r: (d) => d.event_name ?? "—" }, { h: "Status", r: (d) => <Badge value={d.status} tone="amber" /> }, { h: "Accepted", r: (d) => fmtTime(d.accepted_at) },
        ]} />
      </Card>
      {sel && detail.data && (
        <Card title={`Deal ${detail.data.deal.deal_ref}`}>
          {detail.data.deal.mode === "SANDBOX" && <div className="mb-3 rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-200">SANDBOX deal: a simulated workflow. Not a real-world transaction.</div>}
          <div className="mb-2 text-sm">Human approvals on this deal: <b>{detail.data.humanApprovals}</b></div>
          <pre className="mb-3 max-h-48 overflow-auto rounded bg-black/40 p-2 text-xs">{JSON.stringify(detail.data.deal.terms, null, 1)}</pre>
          <h3 className="mb-1 text-xs uppercase text-muted">Deal events</h3><ul className="mb-3 text-[13px]">{(detail.data.events as Row[]).map((e) => <li key={e.id}>{fmtTime(e.created_at)} — {e.summary}</li>)}</ul>
          <h3 className="mb-1 text-xs uppercase text-muted">Audit trail</h3><ul className="text-[12px] text-muted">{(detail.data.audit as Row[]).map((a) => <li key={a.id}>{fmtTime(a.created_at)} · {a.actor_type}:{a.actor_id} · {a.action} · {a.summary}</li>)}</ul>
        </Card>
      )}
      <Card title="Business generated per event (REAL only; sandbox excluded)">
        {analytics.data ? <><p className="mb-2 text-xs text-muted">{analytics.data.note}</p>
          <Table rows={analytics.data.rows} empty="No events yet." cols={[{ h: "Event", r: (e) => e.name }, { h: "Companies", r: (e) => e.companies }, { h: "Matches", r: (e) => e.matches }, { h: "Negotiations", r: (e) => e.negotiations }, { h: "RFQs", r: (e) => e.rfqs }, { h: "Quotations", r: (e) => e.quotations }, { h: "Accepted deals", r: (e) => e.accepted_deals }, { h: "Accepted value", r: (e) => (e.accepted_deals ? e.accepted_value : "—") }, { h: "Sandbox deals", r: (e) => e.sandbox_deals }]} /></> : <Empty>Loading…</Empty>}
      </Card>
    </div>
  );
}
