import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Cap, Card, Chip, Empty, Err, ExtLink, Marker, PageHead, Stat } from "../ui.tsx";
import type { Row } from "../types.ts";

const clock = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (a: string) => a.split("@")[0]!.replace(/-/g, " ");
const ICON: Record<string, string> = { pre_event: "✉️", offer: "💬", field_request: "📨", field_reply: "📷", confirmation: "✅", choose: "🎯", plan: "🗺️", extract: "🔎", briefing: "📋", deal: "🏁", meeting: "🤝", demand: "📊", candidate: "🔦", parse: "🧭", rank: "📊", email: "📨", wait: "⏳", negotiate: "💬", rounds: "💬", think: "🧠", start: "▶️" };
const KIND_LABEL: Record<string, string> = { pre_event: "agent email", offer: "offer email", field_request: "email to your person", field_reply: "reply from your person", confirmation: "acceptance email" };
const FILTERS = [["all", "Everything"], ["email", "Emails"], ["thought", "Reasoning"], ["step", "Steps"]] as const;

function statusOf(p: Row): { label: string; stage: number } {
  if (p.status === "DEAL_CLOSED") return { label: "Deal closed", stage: 4 };
  if (p.status === "NEGOTIATING") return { label: "Agents negotiating by email", stage: 3 };
  if (p.fr_status === "REPLIED") return { label: "Reply received — agents working", stage: 2 };
  if (p.status === "WAITING_REPLY" || p.fr_status === "REQUESTED") return { label: "Emailed — waiting for photo & spec", stage: 1 };
  if (p.status === "FAILED") return { label: "Failed", stage: 0 };
  return { label: String(p.status).replace(/_/g, " ").toLowerCase(), stage: 0 };
}

export function FieldEvent() {
  const { id } = useParams();
  const { data, error } = useApi<Row>(`/field-events/${id}`, 3000);
  const nav = useNavigate();
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [email, setEmail] = useState<Row | null>(null);
  if (error) return <Err msg={error} />;
  if (!data) return <div className="text-muted">Loading…</div>;
  const ev = data.event as Row; const people = data.people as Row[]; const deals = data.deals as Row[]; const meetings = data.meetings as Row[];
  const log = (data.log as Row[]).filter((l) => filter === "all" || l.type === filter);
  const emailsN = (data.log as Row[]).filter((l) => l.type === "email").length;
  const when = ev.start_date ? `${String(ev.start_date).slice(0, 10)}${ev.end_date && ev.end_date !== ev.start_date ? ` → ${String(ev.end_date).slice(0, 10)}` : ""}` : "dates not found on the official page";
  return (
    <div className="space-y-5">
      <Link to="/" className="text-xs text-muted hover:text-accent">← Command Center</Link>
      <PageHead title={String(ev.name)} sub={<>📅 {when} · <ExtLink href={ev.official_url as string}>official site</ExtLink></>} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat value={new Set(people.map((p) => p.person_email)).size} label="People from your company" sub="sent to this event" />
        <Stat value={emailsN} label="Agent emails" sub="logged below" />
        <Stat value={meetings.length} label="Meetings agreed by agents" />
        <Stat value={<span className={deals.length ? "text-accent" : ""}>{deals.length}</span>} label="Deals from this event" />
      </div>

      <Card title="👥 Who from your company is here — and where">
        {people.length ? (
          <div className="grid gap-3 md:grid-cols-2">
            {people.map((p) => {
              const st = statusOf(p); const cp = p.counterpart as Row | null;
              return (
                <div key={String(p.id)} className="border border-edge bg-paper p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center bg-ink text-sm font-semibold text-on-dark">{String(p.person_name).slice(0, 1)}</div>
                    <div className="min-w-0 flex-1"><div className="text-sm font-semibold">{p.person_name}</div><div className="text-[11px] text-muted">{p.person_email}</div></div>
                    {p.deal_ref ? <Badge value="DEAL" tone="green" /> : null}
                  </div>
                  <div className="mt-3 text-[13px]">➡ <b>{p.target_name ?? "choosing the stand…"}</b>{p.stand_hint ? <span className="text-muted"> · stand {p.stand_hint}</span> : null}</div>
                  {cp?.attendees && (cp.attendees as Row[]).length > 0 && <div className="mt-1 text-[12px] text-muted">meeting with {(cp.attendees as Row[]).map((a) => `${a.name} (${a.role})`).join(", ")}</div>}
                  <div className="mt-3 flex items-center gap-1">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="flex flex-1 items-center gap-1"><Marker tone={i < st.stage ? "ok" : i === st.stage ? "active" : "wait"} pulse={i === st.stage && st.stage < 4} />{i < 4 && <span className={`h-px flex-1 ${i < st.stage ? "bg-ink" : "bg-edge"}`} />}</span>)}</div>
                  <div className="mt-2 flex items-center justify-between text-[11px]"><span className="font-medium">{st.label}</span><button className="text-accent hover:underline" onClick={() => void nav(`/missions?open=${p.id}`)}>reasoning ›</button></div>
                  {p.deal_ref ? <div className="mt-2 border-t border-edge pt-2 text-[12px]"><b>{String(p.deal_ref)}</b> · {p.total_value != null ? `${Math.round(Number(p.total_value)).toLocaleString()} ${String(p.currency)}` : "—"} {p.deal_mode === "SANDBOX" ? <Badge value="SANDBOX" tone="amber" /> : null}</div> : null}
                </div>
              );
            })}
          </div>
        ) : <Empty>No person from your company has been sent here yet.</Empty>}
        {meetings.length > 0 && <div className="mt-4 border-t border-edge pt-3"><Cap accent>Agent-to-agent meetings</Cap>{meetings.map((m) => <div key={String(m.id)} className="text-[13px]">🤝 {String(m.target)} — {String(m.status).replace(/_/g, " ").toLowerCase()}{(m.counterpart as Row | null)?.slots ? ` · ${(((m.counterpart as Row).slots) as string[])[0]}` : ""}</div>)}</div>}
      </Card>

      <Card title={`📜 Event log — ${emailsN} emails, every agent step`} actions={<div className="flex gap-1.5">{FILTERS.map(([k, l]) => <Chip key={k} active={filter === k} onClick={() => setFilter(k)}>{l}</Chip>)}</div>}>
        {log.length === 0 ? <Empty>Nothing logged yet for this filter.</Empty> : (
          <ol className="-m-2 max-h-[560px] space-y-0.5 overflow-y-auto p-2">
            {log.map((l) => (
              <li key={`${l.type}-${l.id}`}>
                <button className="flex w-full gap-3 border-b border-edge px-2 py-2 text-left hover:bg-fill" onClick={() => (l.type === "email" ? void api<Row>(`/agent-emails/${l.id}`).then(setEmail) : l.missionId ? void nav(`/missions?open=${l.missionId}`) : undefined)}>
                  <span className="w-16 shrink-0 font-mono text-[10px] text-muted">{clock(String(l.at))}</span>
                  <span className="mt-0.5">{ICON[String(l.kind)] ?? "•"}</span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-[13px] ${l.type === "thought" ? "italic" : "font-medium"}`}>{String(l.title).replace(/^\[[A-Z]+-[\w-]+\]\s*/, "")}</span>
                    <span className="block text-[11px] text-muted">{l.type === "email" ? `${short(String(l.from))} → ${short(String(l.to))} · ${KIND_LABEL[String(l.kind)] ?? "email"} · click to read` : l.type === "thought" ? "agent reasoning" : "agent step"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {email && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-ink/70 p-4" onClick={() => setEmail(null)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto border border-edge bg-paper p-5" onClick={(e) => e.stopPropagation()}>
            <Cap>{short(String(email.from_addr))} → {short(String(email.to_addr))} · {clock(String(email.created_at))}</Cap>
            <div className="mb-3 text-base font-semibold">{email.subject}</div>
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">{email.body}</pre>
            <div className="mt-4 flex justify-end"><Btn onClick={() => setEmail(null)}>Close</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
}
