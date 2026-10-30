import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Cap, Card, Chip, Empty, Err, ExtLink, Marker, PageHead, Stat } from "../ui.tsx";
import type { Row } from "../types.ts";

const fmtDay = (s: string | null) => (s ? s.slice(0, 10) : null);
const clock = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (a: string) => a.split("@")[0]!.replace(/-/g, " ");
const money = (v: number, cur: string) => `${Math.round(v).toLocaleString()} ${cur}`;
const dates = (e: Row) => (e.startDate ?? e.start_date ? `${fmtDay((e.startDate ?? e.start_date) as string)}${(e.endDate ?? e.end_date) && (e.endDate ?? e.end_date) !== (e.startDate ?? e.start_date) ? ` → ${fmtDay((e.endDate ?? e.end_date) as string)}` : ""}` : "dates not found on the official page");

/** The events that fit this request, ranked. One button per event starts the agents' investigation there. */
function EventOptions({ pv, onSend, busyId }: { pv: Row; onSend: (eventId: number) => void; busyId: number | null }) {
  const ranking = pv.ranking as Row[]; const parsed = pv.parsed as Row; const dem = pv.demand as Row; const already = pv.alreadyThere as Row[];
  return (
    <Card title={`Events that fit “${parsed.product}”${parsed.quantity ? ` × ${parsed.quantity}` : ""}${parsed.deadline ? ` by ${parsed.deadline}` : ""}`}>
      <div className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-1 text-[12px]">
        <span><b className="text-base">{dem.totals.open}</b> open tenders · {dem.totals.awards} recent awards in this category <span className="text-muted">(TED + e-Zamówienia)</span></span>
        {(dem.open as Row[]).slice(0, 2).map((n) => <ExtLink key={String(n.id)} href={n.url as string}>{String(n.title ?? "notice").slice(0, 60)}</ExtLink>)}
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {ranking.map((r, i) => (
          <div key={String(r.eventId)} className={`border p-4 ${i === 0 ? "border-accent bg-mist" : "border-edge bg-paper"}`}>
            <div className="flex items-start justify-between gap-3"><div><div className="text-lg font-semibold leading-tight">{r.name}</div><div className="text-[12px] text-muted">📅 {dates(r)}</div></div>{i === 0 && <Badge value="BEST FIT" tone="green" />}</div>
            <ul className="mt-3 space-y-1 text-[13px]">
              <li><b>{r.matching}</b> matching exhibitors <span className="text-muted">({r.specific} mention exactly your product)</span></li>
              <li>{r.fitsDeadline === true ? <>✅ takes place <b>before your deadline</b></> : r.fitsDeadline === false ? <>⚠️ does <b>not</b> fit your deadline</> : "no deadline in your request"}</li>
              <li className="text-muted">e.g. {(r.examples as string[]).join(", ") || "—"}</li>
              <li className="text-[11px] text-muted">{r.exhibitors - r.pendingProfiles} of {r.exhibitors} exhibitor profiles read{r.pendingProfiles ? " — research still running" : ""}</li>
            </ul>
            <div className="mt-4"><Btn tone={i === 0 ? "primary" : "default"} disabled={busyId !== null} onClick={() => onSend(r.eventId as number)}>{busyId === r.eventId ? "Sending agents…" : "Send agents to investigate this event"}</Btn></div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-[12px] text-muted">The agents write to several exhibitors, gather context and tell you whether the event is worth the trip and who to approach. Nobody travels until you approve.{already.length ? ` ${already.map((a) => a.name).join(", ")} is already assigned to one of these events.` : ""}</p>
    </Card>
  );
}

function EventCard({ e }: { e: Row }) {
  const nav = useNavigate();
  const people = e.people as Row[];
  return (
    <button onClick={() => void nav(e.campaign ? `/campaign/${(e.campaign as Row).id}` : `/field-events/${e.id}`)} className="border border-edge bg-paper p-4 text-left transition hover:border-accent">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0"><div className="truncate text-base font-semibold">{e.name}</div><div className="text-[12px] text-muted">📅 {dates(e)}</div></div>
        {e.campaign ? <Badge value={({ INVESTIGATING: "BEFORE · investigating", INVESTIGATED: "BEFORE · needs you", IN_EVENT: "WHILE · at event", COMPLETE: "AFTER · complete", FAILED: "FAILED" } as Record<string, string>)[(e.campaign as Row).status as string] ?? "CAMPAIGN"} tone={(e.campaign as Row).status === "COMPLETE" ? "green" : "amber"} /> : e.deals > 0 ? <Badge value="DEAL" tone="green" /> : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">{people.length ? people.map((p) => <span key={String(p.email)} className="inline-flex items-center gap-1.5 border border-edge px-2 py-1 text-[12px]"><span className="grid h-5 w-5 place-items-center bg-ink text-[10px] font-semibold text-on-dark">{String(p.name).slice(0, 1)}</span>{p.name}</span>) : <span className="text-[12px] text-muted">agents only — nobody sent yet</span>}</div>
      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-edge pt-2 text-center text-[11px]"><div><div className="text-lg font-semibold tabular-nums">{people.length}</div><div className="text-muted">people</div></div><div><div className="text-lg font-semibold tabular-nums">{e.emails}</div><div className="text-muted">agent emails</div></div><div><div className="text-lg font-semibold tabular-nums">{e.deals ?? 0}</div><div className="text-muted">deals</div></div></div>
      <div className="mt-2 text-[11px] text-accent">{e.campaign ? "open the campaign ›" : "open event log ›"}</div>
    </button>
  );
}

const ICON: Record<string, string> = { pre_event: "✉️", offer: "💬", field_request: "📨", field_reply: "📷", confirmation: "✅", choose: "🎯", plan: "🗺️", extract: "🔎", briefing: "📋", deal: "🏁", meeting: "🤝", demand: "📊", candidate: "🔦" };
const KIND_LABEL: Record<string, string> = { pre_event: "agent email", offer: "offer email", field_request: "email to your person", field_reply: "reply from your person", confirmation: "acceptance email" };

export function Command() {
  const { data, error } = useApi<Row>("/command-center", 2500);
  const events = useApi<Row[]>("/field-events", 2500);
  const chips = useApi<string[]>("/demo/suggestions");
  const nav = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [pv, setPv] = useState<Row | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [finding, setFinding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState<Row | null>(null);
  const find = async (text: string, eventId?: number) => {
    setFinding(true); setErr(null);
    try { setPv(await api<Row>("/events-preview", { body: { prompt: text, eventId } })); } catch (e) { setPv(null); setErr((e as Error).message); } finally { setFinding(false); }
  };
  const send = async (eventId: number) => {
    setBusyId(eventId); setErr(null);
    try { const r = await api<Row>("/campaigns", { body: { prompt, eventId } }); void nav(`/campaign/${r.id}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusyId(null); }
  };
  const openEmail = async (id: number) => setEmail(await api<Row>(`/agent-emails/${id}`));
  const d = data?.data as Row | undefined; const k = data?.kpis as Row | undefined;
  const missions = (data?.missions as Row[] | undefined) ?? []; const feed = (data?.feed as Row[] | undefined) ?? [];
  const deals = missions.filter((m) => m.status === "DEAL_CLOSED");
  const dealValue = Object.entries((k?.dealValue ?? {}) as Record<string, number>).map(([key, v]) => { const [mode, cur] = key.split(":"); return `${money(v, cur!)}${mode === "SANDBOX" ? " (sandbox)" : ""}`; }).join(" · ");
  const closedCount = (k?.dealsClosed as number | undefined) ?? 0;
  return (
    <div className="space-y-5">
      <PageHead title="Command Center" sub="Tell your agents which event you care about. They find the stands, send your people, negotiate by email and close."
        actions={<><span className="flex items-center gap-1.5 text-[11px] text-muted"><Marker tone="active" pulse />live</span><Link className="text-[12px] text-accent underline-offset-2 hover:underline" to="/missions">All missions</Link></>} />

      <Card title="What do you need to source?">
        <div className="flex gap-2">
          <input className="!py-3 !text-base" placeholder="e.g. Find me events where I can source 200 thermal cameras by Q1." value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && prompt.length > 7 && !finding) void find(prompt); }} />
          <Btn tone="primary" disabled={finding || prompt.length < 8} onClick={() => void find(prompt)}>{finding ? "Looking…" : "Find events"}</Btn>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">{(chips.data ?? []).map((c) => <Chip key={c} onClick={() => { setPrompt(c); void find(c); }}>{c}</Chip>)}</div>
        <div className="mt-2"><Err msg={err ?? error} /></div>
      </Card>

      {pv && <EventOptions pv={pv} busyId={busyId} onSend={(id) => void send(id)} />}

      <Card title="📍 Events where your people are">
        {(events.data ?? []).length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{(events.data ?? []).map((e) => <EventCard key={String(e.id)} e={e} />)}</div>
          : <Empty>No agents are on any event yet. Find an event above and send them — every event then gets its own log with who is there and what the agents did.</Empty>}
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat value={k?.peopleSent ?? 0} label="People sent to events" sub={`${k?.peopleActive ?? 0} active right now`} />
        <Stat value={k?.agentEmails ?? 0} label="Agent emails sent" sub="every one logged" />
        <Stat value={d?.openTenders ?? 0} label="Open tenders (demand)" sub={`${d?.openTendersWithDeadline ?? 0} with a published deadline`} />
        <Stat value={d?.suppliersWithEvidence ?? 0} label="Suppliers with evidence" sub={`of ${d?.companies ?? 0} companies`} />
        <Stat value={<span className={closedCount > 0 ? "text-accent" : ""}>{closedCount}</span>} label="Deals closed" sub={dealValue || "no deals yet"} />
        <Stat value={<span className={closedCount > 0 ? "text-accent" : ""}>{k?.humanApprovals ?? 0}</span>} label="Human approvals" sub="autonomous closing" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
        <Card title="🤝 Deals">
          {deals.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]"><thead><tr className="border-b border-edge">{["Deal", "Supplier", "Event", "Value", "Human approvals", ""].map((h) => <th key={h} className="ds-cap px-2 py-2">{h}</th>)}</tr></thead>
                <tbody>{deals.map((m) => (
                  <tr key={String(m.id)} className="cursor-pointer border-b border-edge hover:bg-fill" onClick={() => void nav(`/missions?open=${m.id}`)}>
                    <td className="px-2 py-2 font-semibold">{m.deal_ref} {m.deal_mode === "SANDBOX" && <Badge value="SANDBOX" tone="amber" />}</td><td className="px-2 py-2">{m.target_name}</td><td className="px-2 py-2 text-muted">{m.event_name}</td>
                    <td className="px-2 py-2 font-semibold">{m.total_value != null ? money(Number(m.total_value), String(m.currency)) : "—"}</td><td className="px-2 py-2"><Badge value={`${m.human_approvals} approvals`} tone="green" /></td><td className="px-2 py-2 text-[11px] text-accent">open ›</td>
                  </tr>))}</tbody></table>
            </div>
          ) : <Empty>No deals yet. They appear here the moment two agents agree — with the number of human approvals next to them.</Empty>}
        </Card>

        <Card title="⚡ Live agent activity — every email, logged">
          <div className="-m-2 max-h-[420px] space-y-0.5 overflow-y-auto p-2">
            {feed.length === 0 && <div className="p-6 text-center text-sm text-muted">Agent actions and emails appear here as they happen.</div>}
            {feed.map((f) => (
              <button key={`${f.type}-${f.id}`} onClick={() => (f.type === "email" ? void openEmail(f.id as number) : f.missionId ? void nav(`/missions?open=${f.missionId}`) : undefined)} className="flex w-full animate-[fadein_.3s_ease] gap-2 border-b border-edge px-2 py-2 text-left text-[12px] hover:bg-fill">
                <span className="mt-0.5">{ICON[String(f.kind)] ?? "•"}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{String(f.title).replace(/^\[[A-Z]+-[\w-]+\]\s*/, "")}</span><span className="block truncate text-[11px] text-muted">{f.type === "email" ? `${short(String(f.from))} → ${short(String(f.to))} · ${KIND_LABEL[String(f.kind)] ?? "email"}` : "agent step"}</span></span>
                <span className="shrink-0 text-[10px] text-muted">{clock(String(f.at))}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

      <Card>
        <div className="grid gap-4 text-[12px] md:grid-cols-4">
          <div><Cap accent>Real public data</Cap><div>TED: <b>{d?.tedNotices ?? 0}</b> notices{d?.tedLastSync ? ` · synced ${clock(String(d.tedLastSync))}` : ""}</div><div>e-Zamówienia: <b>{d?.ezNotices ?? 0}</b> notices</div></div>
          <div><Cap accent>Supply side</Cap><div><b>{d?.events ?? 0}</b> events researched</div><div><b>{d?.exhibitorsRead ?? 0}</b> exhibitor profiles read</div></div>
          <div><Cap accent>Demand side</Cap><div><b>{d?.openTenders ?? 0}</b> open tenders</div><div className="text-muted">buyer agent acts within a mandate</div></div>
          <div><Cap accent>Every number</Cap><div className="text-muted">is counted from stored records — nothing is estimated.</div></div>
        </div>
      </Card>

      {email && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4" onClick={() => setEmail(null)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto border border-edge bg-paper p-5" onClick={(e) => e.stopPropagation()}>
            <Cap>{short(String(email.from_addr))} → {short(String(email.to_addr))} · {clock(String(email.created_at))}</Cap>
            <div className="mb-3 text-base font-semibold">{email.subject}</div>
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">{email.body}</pre>
            <div className="mt-4 flex justify-end gap-2">{email.mission_id ? <Btn onClick={() => void nav(`/missions?open=${email.mission_id}`)}>Open mission</Btn> : null}<Btn onClick={() => setEmail(null)}>Close</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
}
