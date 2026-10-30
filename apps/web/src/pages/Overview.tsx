import { Link } from "react-router";
import { useApi } from "../api.ts";
import { Badge, Card, Empty, Err, PageHead, Stat, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Overview() {
  const ov = useApi<Row>("/overview", 10000);
  const feed = useApi<Row[]>("/activity?limit=25", 10000);
  const o = ov.data;
  const nothing = o && o.events.discovered === 0 && o.companies.total === 0 && o.procurement.notices === 0;
  return (
    <div className="space-y-5">
      <PageHead title="Overview" sub="Every number is a count of persisted records. Nothing is estimated." />
      <Err msg={ov.error} />
      {nothing && <Empty>No data yet. Start with <Link className="text-accent underline-offset-2 hover:underline hover:text-accent" to="/events">Event Intelligence</Link> (add an official event URL) or sync procurement notices in <Link className="text-accent underline-offset-2 hover:underline hover:text-accent" to="/procurement">Procurement Intelligence</Link>.</Empty>}
      {o && (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Events discovered" value={o.events.discovered} sub={`${o.events.researched} researched · ${o.events.monitored} monitored`} />
            <Stat label="Exhibitors extracted" value={o.exhibitors.total} sub={`${o.exhibitors.resolvedToCompany} resolved to companies`} />
            <Stat label="Companies" value={o.companies.total} sub={`${o.companies.identified} identified · ${o.companies.verified} verified · ${o.companies.enriched} enriched`} />
            <Stat label="Procurement notices" value={o.procurement.notices} sub={`${o.procurement.confirmedDemand} confirmed demand`} />
            <Stat label="Buyer requirements" value={o.marketplace.buyerRequirements} />
            <Stat label="Supplier offerings" value={o.marketplace.supplierOfferings} />
            <Stat label="Matches" value={o.marketplace.matches} sub={`${o.marketplace.verifiedMatches} verified`} />
            <Stat label="Active negotiations" value={o.negotiations.active} sub={`${o.negotiations.real} real · ${o.negotiations.sandbox} sandbox`} />
            <Stat label="Real deals recorded" value={o.deals.real} sub={`Sandbox deals (not business): ${o.deals.sandbox}`} />
            <Stat label="Agent tasks" value={o.tasks.queued + o.tasks.running} sub={`${o.tasks.running} running · ${o.tasks.failed} failed · ${o.tasks.waitingApproval} awaiting approval`} />
          </div>
          <Card title="Connector health">
            <div className="grid gap-2 md:grid-cols-2">
              {o.connectors.map((c: Row) => (
                <div key={c.key} className="flex items-center justify-between border border-edge px-3 py-2 text-[13px]">
                  <div><div>{c.name}</div><div className="text-[11px] text-muted">{c.last_success_at ? `Last success ${fmtTime(c.last_success_at)}` : "Never synchronised"}{c.last_error ? ` · ${c.last_error.slice(0, 80)}` : ""}</div></div>
                  <Badge value={c.status} />
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
      <Card title="Activity feed (persisted backend events)">
        {feed.data?.length ? (
          <ul className="space-y-1.5 text-[13px]">
            {feed.data.map((a) => (
              <li key={a.id} className="flex gap-3">
                <span className="w-40 shrink-0 font-mono text-[11px] text-muted">{fmtTime(a.created_at)}</span>
                <span className="w-40 shrink-0 font-mono text-[11px] text-accent">{a.action}</span>
                <span className="min-w-0 flex-1 truncate">{a.summary}</span>
                <ActivityLink a={a} />
              </li>
            ))}
          </ul>
        ) : <Empty>No activity recorded yet.</Empty>}
      </Card>
    </div>
  );
}

function ActivityLink({ a }: { a: Row }) {
  const map: Record<string, string> = { event: "/events/", company: "/companies/", negotiation: "/negotiations/" };
  const base = map[a.entity_type as string];
  if (a.entity_type === "task") return <Link to="/agents" className="text-xs text-accent underline-offset-2 hover:underline hover:text-accent">task #{a.entity_id}</Link>;
  return base && a.entity_id ? <Link to={`${base}${a.entity_id}`} className="text-xs text-accent underline-offset-2 hover:underline hover:text-accent">open</Link> : <span />;
}
