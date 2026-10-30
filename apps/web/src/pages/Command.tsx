import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Err } from "../ui.tsx";
import type { Row } from "../types.ts";

const STAGES = ["Agents searching", "Person emailed", "On site · reply", "Negotiating", "Deal closed"];
const fmtDay = (s: string | null) => (s ? s.slice(0, 10) : null);
const clock = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (a: string) => a.split("@")[0]!.replace(/-/g, " ");
const money = (v: number, cur: string) => `${Math.round(v).toLocaleString()} ${cur}`;

function Tile({ value, label, sub, accent }: { value: string | number; label: string; sub?: string; accent?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${accent ? "border-emerald-400/50 bg-emerald-500/10" : "border-edge bg-panel"}`}>
      <div className={`text-3xl font-extrabold tabular-nums ${accent ? "text-emerald-300" : "text-white"}`}>{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      {sub && <div className="mt-1 text-[11px] text-muted">{sub}</div>}
    </div>
  );
}

function Progress({ stage }: { stage: number }) {
  return (
    <div className="mt-3 flex items-center gap-1">
      {STAGES.map((s, i) => (
        <div key={s} className="flex flex-1 items-center gap-1" title={s}>
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${i < stage ? "bg-emerald-400" : i === stage ? "animate-pulse bg-amber-400" : "bg-edge"}`} />
          {i < STAGES.length - 1 && <span className={`h-px flex-1 ${i < stage ? "bg-emerald-400/60" : "bg-edge"}`} />}
        </div>
      ))}
    </div>
  );
}

function FieldCard({ m }: { m: Row }) {
  const nav = useNavigate();
  const pre = m.kind === "PREEVENT";
  const label = m.status === "DEAL_CLOSED" ? "Deal closed" : m.status === "NEGOTIATING" ? "Agents negotiating by email" : m.status === "MEETING_PLANNED" ? "Meeting agreed by the agents" : m.status === "WAITING_REPLY" ? `Waiting for ${m.person_name ?? "the person"}'s photo & spec` : m.status === "RUNNING" ? "Agents working…" : String(m.status).replace(/_/g, " ").toLowerCase();
  return (
    <button onClick={() => nav(`/missions?open=${m.id}`)} className="rounded-xl border border-edge bg-panel p-4 text-left transition hover:border-accent">
      <div className="flex items-start gap-3">
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-bold ${pre ? "bg-sky-500/20 text-sky-300" : "bg-amber-500/20 text-amber-300"}`}>{pre ? "🤝" : String(m.person_name ?? "?").slice(0, 1)}</div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{pre ? "Agents talking before the event" : m.person_name ?? "Salesperson"}</div>
          <div className="truncate text-[12px] text-slate-300">📍 {m.event_name ?? "event pending"}{m.start_date ? ` · ${fmtDay(m.start_date)}` : ""}</div>
          <div className="truncate text-[12px] text-muted">{m.target_name ? `${m.target_name}${m.stand_hint ? ` · stand ${m.stand_hint}` : ""}` : "choosing the stand…"}</div>
        </div>
        {m.status === "DEAL_CLOSED" && <Badge value="DEAL" tone="green" />}
      </div>
      <Progress stage={m.stage as number} />
      <div className="mt-2 flex items-center justify-between text-[11px]"><span className="font-medium text-slate-200">{label}</span><span className="text-muted">{pre ? `${m.pre_mails} agent emails` : m.sent_at ? `emailed ${clock(String(m.sent_at))}` : ""}</span></div>
    </button>
  );
}

const ICON: Record<string, string> = { pre_event: "✉️", offer: "💬", field_request: "📨", field_reply: "📷", confirmation: "✅", choose: "🎯", plan: "🗺️", extract: "🔎", briefing: "📋", deal: "🏁", meeting: "🤝", demand: "📊", candidate: "🔦" };
const KIND_LABEL: Record<string, string> = { pre_event: "agent email", offer: "offer email", field_request: "email to your person", field_reply: "reply from your person", confirmation: "acceptance email" };

export function Command() {
  const { data, error } = useApi<Row>("/command-center", 2000);
  const chips = useApi<string[]>("/demo/suggestions");
  const chips3 = useApi<string[]>("/demo/suggestions-preevent");
  const nav = useNavigate();
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [email, setEmail] = useState<Row | null>(null);
  const go = async (text: string) => {
    setBusy(true); setErr(null);
    try { const r = await api<Row>("/missions", { body: /start-?up|early[- ]stage/i.test(text) ? { prompt: text, preevent: {} } : { prompt: text } }); void nav(`/missions?open=${r.id}`); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const openEmail = async (id: number) => setEmail(await api<Row>(`/agent-emails/${id}`));
  const d = data?.data as Row | undefined; const k = data?.kpis as Row | undefined; const p = data?.pipeline as Row | undefined;
  const missions = (data?.missions as Row[] | undefined) ?? []; const feed = (data?.feed as Row[] | undefined) ?? [];
  const deals = missions.filter((m) => m.status === "DEAL_CLOSED");
  const field = missions.filter((m) => m.status !== "FAILED");
  const dealValue = Object.entries((k?.dealValue ?? {}) as Record<string, number>).map(([key, v]) => { const [mode, cur] = key.split(":"); return `${money(v, cur!)}${mode === "SANDBOX" ? " (sandbox)" : ""}`; }).join(" · ");
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-extrabold tracking-tight">Command Center</h1><p className="text-sm text-muted">Your agents work the European defence market — from public tenders to a closed deal, over email.</p></div>
        <div className="flex items-center gap-3 text-[11px] text-muted"><span className="flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />live</span><Link className="underline" to="/missions">All missions</Link></div>
      </div>

      <div className="rounded-xl border border-edge bg-gradient-to-br from-panel to-ink p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-accent">Tell your agents what you need</div>
        <div className="flex gap-2">
          <input className="!py-3 !text-base" placeholder="e.g. Find me events where I can source 200 thermal cameras by Q1." value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && prompt.length > 7 && !busy) void go(prompt); }} />
          <Btn tone="primary" disabled={busy || prompt.length < 8} onClick={() => void go(prompt)}>{busy ? "Starting…" : "Send my agents"}</Btn>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">{[...(chips.data ?? []).slice(0, 2), ...(chips3.data ?? []).slice(0, 1)].map((c) => <button key={c} className="rounded-full border border-edge px-3 py-1 text-xs text-slate-300 hover:border-accent hover:text-accent" onClick={() => setPrompt(c)}>{c}</button>)}</div>
        <div className="mt-2"><Err msg={err ?? error} /></div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Tile value={k?.peopleSent ?? 0} label="People sent to events" sub={`${k?.peopleActive ?? 0} active right now`} />
        <Tile value={k?.agentEmails ?? 0} label="Agent emails sent" sub="all logged" />
        <Tile value={d?.openTenders ?? 0} label="Open tenders (demand)" sub={`${d?.openTendersWithDeadline ?? 0} with a published deadline · TED + e-Zamówienia`} />
        <Tile value={d?.suppliersWithEvidence ?? 0} label="Suppliers with evidence" sub={`of ${d?.companies ?? 0} companies`} />
        <Tile value={k?.dealsClosed ?? 0} label="Deals closed" sub={dealValue || "no deals yet"} accent={(k?.dealsClosed ?? 0) > 0} />
        <Tile value={k?.humanApprovals ?? 0} label="Human approvals" sub="autonomous closing" accent={(k?.dealsClosed ?? 0) > 0} />
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {[["Searching", p?.searching], ["Waiting at event", p?.waiting], ["Negotiating", p?.negotiating], ["Meeting planned", p?.meeting], ["Deals closed", p?.closed]].map(([l, v]) => (
          <div key={String(l)} className="flex items-center justify-between rounded-lg border border-edge bg-panel px-3 py-2 text-xs"><span className="text-muted">{l}</span><span className="text-lg font-bold tabular-nums">{String(v ?? 0)}</span></div>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_400px]">
        <div className="space-y-5">
          <section>
            <h2 className="mb-2 text-sm font-semibold tracking-wide">📍 Your people in the field</h2>
            {field.length ? <div className="grid gap-3 md:grid-cols-2">{field.map((m) => <FieldCard key={String(m.id)} m={m} />)}</div>
              : <div className="rounded-xl border border-dashed border-edge p-8 text-center text-sm text-muted">Nobody is in the field yet. Send your agents above — they will pick an event, choose the stands and email your person.</div>}
          </section>
          <section>
            <h2 className="mb-2 text-sm font-semibold tracking-wide">🤝 Deals</h2>
            {deals.length ? (
              <div className="overflow-hidden rounded-xl border border-edge">
                <table className="w-full text-left text-[13px]"><thead className="bg-panel text-[11px] uppercase tracking-wider text-muted"><tr><th className="px-3 py-2">Deal</th><th className="px-3 py-2">Supplier</th><th className="px-3 py-2">Event</th><th className="px-3 py-2">Value</th><th className="px-3 py-2">Human approvals</th><th className="px-3 py-2" /></tr></thead>
                  <tbody>{deals.map((m) => (
                    <tr key={String(m.id)} className="cursor-pointer border-t border-edge/60 hover:bg-white/5" onClick={() => nav(`/missions?open=${m.id}`)}>
                      <td className="px-3 py-2 font-semibold text-emerald-300">{m.deal_ref} {m.deal_mode === "SANDBOX" && <Badge value="SANDBOX" tone="amber" />}</td><td className="px-3 py-2">{m.target_name}</td><td className="px-3 py-2 text-muted">{m.event_name}</td>
                      <td className="px-3 py-2 font-semibold">{m.total_value != null ? money(Number(m.total_value), String(m.currency)) : "—"}</td><td className="px-3 py-2"><Badge value={`${m.human_approvals} approvals`} tone="green" /></td><td className="px-3 py-2 text-[11px] text-sky-300">open ›</td>
                    </tr>))}</tbody></table>
              </div>
            ) : <div className="rounded-xl border border-dashed border-edge p-6 text-center text-sm text-muted">No deals yet. They appear here the moment two agents agree — with the number of human approvals next to them.</div>}
          </section>
        </div>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold tracking-wide">⚡ Live agent activity <span className="text-[11px] font-normal text-muted">every email, logged</span></h2>
          <div className="max-h-[640px] space-y-1.5 overflow-y-auto rounded-xl border border-edge bg-panel p-2">
            {feed.length === 0 && <div className="p-6 text-center text-sm text-muted">Agent actions and emails appear here as they happen.</div>}
            {feed.map((f) => (
              <button key={`${f.type}-${f.id}`} onClick={() => (f.type === "email" ? void openEmail(f.id as number) : f.missionId && void nav(`/missions?open=${f.missionId}`))} className="flex w-full animate-[fadein_.3s_ease] gap-2 rounded-lg border border-transparent px-2 py-1.5 text-left text-[12px] hover:border-edge hover:bg-white/5">
                <span className="mt-0.5">{ICON[String(f.kind)] ?? "•"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{String(f.title).replace(/^\[[A-Z]+-[\w-]+\]\s*/, "")}</span>
                  <span className="block truncate text-[11px] text-muted">{f.type === "email" ? `${short(String(f.from))} → ${short(String(f.to))} · ${KIND_LABEL[String(f.kind)] ?? "email"}` : "agent step"}</span>
                </span>
                <span className="shrink-0 text-[10px] text-muted">{clock(String(f.at))}</span>
              </button>
            ))}
          </div>
        </section>
      </div>

      <div className="grid gap-3 rounded-xl border border-edge bg-panel p-4 text-[12px] md:grid-cols-4">
        <div><div className="text-[10px] font-semibold uppercase tracking-wider text-accent">Real public data</div><div className="mt-1 text-slate-300">TED: <b>{d?.tedNotices ?? 0}</b> notices{d?.tedLastSync ? ` · synced ${clock(String(d.tedLastSync))}` : ""}</div><div className="text-slate-300">e-Zamówienia: <b>{d?.ezNotices ?? 0}</b> notices</div></div>
        <div><div className="text-[10px] font-semibold uppercase tracking-wider text-accent">Supply side</div><div className="mt-1 text-slate-300"><b>{d?.events ?? 0}</b> events researched</div><div className="text-slate-300"><b>{d?.exhibitorsRead ?? 0}</b> exhibitor profiles read</div></div>
        <div><div className="text-[10px] font-semibold uppercase tracking-wider text-accent">Demand side</div><div className="mt-1 text-slate-300"><b>{d?.openTenders ?? 0}</b> open tenders</div><div className="text-slate-300">buyer agent acts within a mandate</div></div>
        <div><div className="text-[10px] font-semibold uppercase tracking-wider text-accent">Every number</div><div className="mt-1 text-slate-300">is counted from stored records — nothing is estimated.</div></div>
      </div>

      {email && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={() => setEmail(null)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-edge bg-panel p-5" onClick={(e) => e.stopPropagation()}>
            <div className="mb-1 text-[11px] uppercase tracking-wider text-muted">{short(String(email.from_addr))} → {short(String(email.to_addr))} · {clock(String(email.created_at))}</div>
            <div className="mb-3 text-base font-semibold">{email.subject}</div>
            <pre className="whitespace-pre-wrap font-sans text-[13px] leading-relaxed">{email.body}</pre>
            <div className="mt-4 flex justify-end gap-2">{email.mission_id && <Btn onClick={() => nav(`/missions?open=${email.mission_id}`)}>Open mission</Btn>}<Btn onClick={() => setEmail(null)}>Close</Btn></div>
          </div>
        </div>
      )}
    </div>
  );
}
