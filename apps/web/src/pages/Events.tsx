import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, ExtLink, PageHead, Stat, Table, Unknown, fmtDate, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Events() {
  const { data, error, reload } = useApi<Row[]>("/events", 5000);
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const nav = useNavigate();
  const add = async () => {
    try { const r = await api<Row>("/events", { body: { url } }); setUrl(""); setMsg(r.created ? "Event added; research task queued." : "Event already exists."); reload(); void nav(`/events/${r.id}`); } catch (e) { setMsg((e as Error).message); }
  };
  const groups: [string, Row[]][] = [["Upcoming", []], ["Ongoing", []], ["Historical", []], ["Dates unknown", []]];
  for (const e of data ?? []) groups[{ UPCOMING: 0, ONGOING: 1, HISTORICAL: 2, UNKNOWN_DATES: 3 }[e.phase as string] ?? 3]![1].push(e);
  return (
    <div className="space-y-5">
      <PageHead title="Event Intelligence" sub="Official events, their exhibitors and monitoring status. Dates and exhibitors come only from official sources." actions={<Btn size="lg" onClick={() => void api("/events/discover", { body: {} }).then(() => setMsg("Discovery task queued — see Agent Manager."))}>Run Event Discovery</Btn>} />
      <Card title="Add an event by official URL">
        <div className="flex gap-2"><input className="min-w-0 flex-1" placeholder="https://www.example-event.com/" value={url} onChange={(e) => setUrl(e.target.value)} /><Btn tone="primary" onClick={() => void add()} disabled={!url}>Add &amp; research</Btn></div>
        {msg && <div className="mt-2 text-xs text-muted">{msg}</div>}
      </Card>
      <Err msg={error} />
      {data && data.length === 0 && <Empty>No events yet. Add an official event URL above or run Event Discovery.</Empty>}
      {groups.filter(([, r]) => r.length).map(([label, rows]) => (
        <Card key={label} title={`${label} (${rows.length})`}>
          <Table rows={rows} onRow={(r) => nav(`/events/${r.id}`)} cols={[
            { h: "Event", r: (r) => <div><div className="font-medium">{r.name}</div><div className="text-[11px] text-muted">{r.official_url}</div></div> },
            { h: "Dates", r: (r) => r.start_date ? `${fmtDate(r.start_date)} → ${fmtDate(r.end_date)}` : <Unknown label="Not found on official page" /> },
            { h: "Research", r: (r) => <Badge value={r.research_status} /> },
            { h: "Exhibitors", r: (r) => <div>{r.exhibitors}{r.pending_profiles ? <span className="text-[11px] text-muted"> ({r.pending_profiles} profiles pending)</span> : null}</div> },
            { h: "Identified / verified", r: (r) => `${r.identified_companies} / ${r.verified_companies}` },
            { h: "Monitoring", r: (r) => r.interval_minutes ? <div className="text-[11px]">every {r.interval_minutes >= 60 ? `${Math.round(r.interval_minutes / 60)} h` : `${r.interval_minutes} min`}<br />checked {fmtTime(r.last_checked_at) ?? "never"}<br />{r.changes_detected} changes</div> : <Unknown label="Off" /> },
          ]} />
        </Card>
      ))}
    </div>
  );
}

export function EventDetail() {
  const { id } = useParams();
  const { data, error, reload } = useApi<Row>(`/events/${id}`, 4000);
  const [q, setQ] = useState("");
  const ex = useApi<Row>(`/events/${id}/exhibitors?limit=50${q ? `&q=${encodeURIComponent(q)}` : ""}`, 8000);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <Err msg={error} />;
  if (!data) return <div className="text-muted">Loading…</div>;
  const e = data.event as Row;
  const s = data.stats as Row;
  const running = (data.tasks as Row[]).some((t) => ["RUNNING", "QUEUED", "RETRY_SCHEDULED"].includes(t.status));
  const act = async (path: string, body: unknown = {}) => { try { const r = await api<Row>(path, { body }); setMsg(r.note ?? "Done"); reload(); } catch (err) { setMsg((err as Error).message); } };
  return (
    <div className="space-y-5">
      <div className="space-y-2"><Link to="/events" className="ds-cap inline-block hover:text-accent">← Events</Link>
        <PageHead title={e.name} sub={<ExtLink href={e.official_url} />} actions={<><Btn size="lg" tone="primary" disabled={running} onClick={() => void act(`/events/${id}/research`)}>{running ? "Research in progress…" : "RESEARCH EVENT"}</Btn><Btn onClick={() => void act(`/events/${id}/check-now`)}>Check for changes now</Btn></>} />
      </div>
      {msg && <div className="text-xs text-muted">{msg}</div>}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Exhibitors" value={s.exhibitors} sub={s.pendingProfiles ? `${s.pendingProfiles} profiles still to read` : undefined} />
        <Stat label="Companies resolved" value={s.companies} /><Stat label="With website" value={s.withWebsite} /><Stat label="Matches" value={s.matches} />
        <Stat label="Research" value={<Badge value={e.research_status} />} sub={`Last: ${fmtTime(e.last_researched_at) ?? "never"}`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Overview">
          <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[13px]">
            <dt className="text-muted">Dates</dt><dd>{e.start_date ? `${fmtDate(e.start_date)} → ${fmtDate(e.end_date)}` : <Unknown label="Not found on official page" />}</dd>
            {e.dates_evidence && (<><dt className="text-muted">Date evidence</dt><dd className="text-[12px] italic text-muted">“{e.dates_evidence}”</dd></>)}
            <dt className="text-muted">Organizer</dt><dd>{e.organizer ?? <Unknown label="Not stated on page" />}</dd>
            <dt className="text-muted">Description</dt><dd>{e.description ?? <Unknown />}</dd>
            <dt className="text-muted">Directory</dt><dd><ExtLink href={e.exhibitor_directory_url} /></dd>
            <dt className="text-muted">Strategy</dt><dd className="text-[12px]">{e.exhibitor_strategy ?? <Unknown />}</dd>
            <dt className="text-muted">Relevance</dt><dd>{e.relevance_score != null ? `${Math.round(e.relevance_score * 100)}% — ${(e.relevance_reasons as string[]).join("; ") || "no category terms found"}` : <Unknown />}</dd>
          </dl>
        </Card>
        <Card title="Monitoring (periodic polling, not real-time)" actions={data.monitoring ? <Btn onClick={() => void act(`/events/${id}/monitoring`, { intervalMinutes: data.monitoring.interval_minutes, enabled: !data.monitoring.enabled })}>{data.monitoring.enabled ? "Disable" : "Enable"}</Btn> : null}>
          {data.monitoring ? (
            <dl className="grid grid-cols-[150px_1fr] gap-y-1.5 text-[13px]">
              <dt className="text-muted">Frequency</dt><dd>every {data.monitoring.interval_minutes} min</dd>
              <dt className="text-muted">Last checked</dt><dd>{fmtTime(data.monitoring.last_checked_at) ?? "never"}</dd>
              <dt className="text-muted">Last successful</dt><dd>{fmtTime(data.monitoring.last_success_at) ?? "never"}</dd>
              <dt className="text-muted">Changes detected</dt><dd>{data.monitoring.changes_detected}</dd>
              <dt className="text-muted">Next check</dt><dd>{data.monitoring.enabled ? fmtTime(data.monitoring.next_run_at) : "disabled"}</dd>
              <dt className="text-muted">Error</dt><dd className={data.monitoring.last_error ? "text-alert" : ""}>{data.monitoring.last_error ?? "none"}</dd>
            </dl>
          ) : <Empty>Monitoring starts after the first successful research.</Empty>}
          <div className="mt-3 flex items-center gap-2 text-xs text-muted">Set frequency:
            {[60, 360, 1440].map((m) => <Btn key={m} onClick={() => void act(`/events/${id}/monitoring`, { intervalMinutes: m })}>{m >= 60 ? `${m / 60} h` : `${m} min`}</Btn>)}</div>
        </Card>
      </div>
      <Card title={`Research tasks (${(data.tasks as Row[]).length})`}>
        <Table rows={data.tasks} empty="No research has been run." cols={[
          { h: "#", r: (t) => t.id }, { h: "Type", r: (t) => t.type }, { h: "Status", r: (t) => <Badge value={t.status} /> },
          { h: "Progress / error", r: (t) => <span className={t.error ? "text-alert" : "text-muted"}>{t.error ?? t.progress_note ?? "—"}</span> },
          { h: "Attempts", r: (t) => t.attempts }, { h: "Started", r: (t) => fmtTime(t.started_at) ?? "—" },
        ]} />
      </Card>
      <Card title={`Exhibitors (${ex.data?.total ?? 0})`} actions={<input className="!w-56" placeholder="Filter by name" value={q} onChange={(ev) => setQ(ev.target.value)} />}>
        <Table rows={ex.data?.rows ?? []} empty="No exhibitors extracted yet." cols={[
          { h: "Exhibitor", r: (x) => x.company_id ? <Link className="text-accent underline-offset-2 hover:underline hover:text-accent" to={`/companies/${x.company_id}`}>{x.exhibitor_name}</Link> : x.exhibitor_name },
          { h: "Country", r: (x) => x.country ?? <Unknown /> }, { h: "Website", r: (x) => x.website ? <ExtLink href={x.website}>{x.website.replace(/^https?:\/\/(www\.)?/, "")}</ExtLink> : <Unknown /> },
          { h: "Stand", r: (x) => x.booth ?? <Unknown /> }, { h: "Identity", r: (x) => <Badge value={x.identity_state ?? (x.resolution_status === "PENDING_DETAIL" ? "PENDING_PROFILE" : "UNKNOWN")} /> },
          { h: "Source", r: (x) => <ExtLink href={x.profile_url ?? x.source_url}>evidence</ExtLink> },
        ]} />
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={`Updates (${(data.updates as Row[]).length})`}><Table rows={data.updates} empty="No changes detected yet." cols={[{ h: "When", r: (u) => fmtTime(u.detected_at) }, { h: "Kind", r: (u) => <Badge value={u.kind} tone="amber" /> }, { h: "Summary", r: (u) => u.summary }]} /></Card>
        <Card title="Sources & documents">
          <ul className="space-y-1 text-[13px]">
            {(data.sources as Row[]).map((src) => <li key={src.id}><Badge value={src.role} tone="blue" /> <ExtLink href={src.url} /> <span className="text-[11px] text-muted">{src.last_http_status ? `HTTP ${src.last_http_status}` : ""} {src.last_fetched_at ? `· fetched ${fmtTime(src.last_fetched_at)}` : ""}</span></li>)}
            {(data.documents as Row[]).map((d) => <li key={d.id}><Badge value={(d.doc_type ?? "doc").toUpperCase()} tone="grey" /> <ExtLink href={d.url}>{d.title || d.url}</ExtLink></li>)}
            {(data.categories as Row[]).length > 0 && <li className="pt-2 text-muted">Categories: {(data.categories as Row[]).map((c) => c.category).join(", ")}</li>}
          </ul>
          {!(data.sources as Row[]).length && !(data.documents as Row[]).length && <Empty>No sources recorded.</Empty>}
        </Card>
      </div>
    </div>
  );
}
