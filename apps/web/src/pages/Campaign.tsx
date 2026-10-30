import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Cap, Card, Empty, Err, Marker, PageHead, Stat } from "../ui.tsx";
import { MailBubble } from "./Preevent.tsx";
import { ReasoningTrace, RepPhone } from "./Mission.tsx";
import type { Row } from "../types.ts";

const clock = (s: string) => new Date(s).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const short = (a: string) => a.split("@")[0]!.replace(/-/g, " ");
const money = (v: number, cur: string) => `${Math.round(v).toLocaleString()} ${cur}`;
type Stage = "BEFORE" | "WHILE" | "AFTER";
const STAGES: { key: Stage; label: string; sub: string }[] = [
  { key: "BEFORE", label: "Before the event", sub: "agents investigate, you approve" },
  { key: "WHILE", label: "While at the event", sub: "agents work with your people" },
  { key: "AFTER", label: "After the event", sub: "follow-ups, summary, deal" },
];
const EMAIL_ICON: Record<string, string> = { pre_event: "✉️", offer: "💬", field_request: "📨", field_reply: "📷", confirmation: "✅", followup: "📤", debrief: "🗨️" };

const phaseOf = (status: string): Stage => (status === "IN_EVENT" ? "WHILE" : status === "COMPLETE" ? "AFTER" : "BEFORE");

function Stepper({ status, tab, setTab, counts }: { status: string; tab: Stage; setTab: (s: Stage) => void; counts: Record<Stage, string> }) {
  const cur = phaseOf(status);
  const order: Stage[] = ["BEFORE", "WHILE", "AFTER"];
  return (
    <div className="grid gap-2 md:grid-cols-3">
      {STAGES.map((st, i) => {
        const done = order.indexOf(cur) > i || status === "COMPLETE";
        const active = cur === st.key && status !== "COMPLETE";
        const waiting = status === "INVESTIGATED" && st.key === "BEFORE";
        return (
          <button key={st.key} onClick={() => setTab(st.key)} className={`border-t-4 p-3 text-left transition ${tab === st.key ? "bg-mist" : "bg-paper hover:bg-fill"} ${done ? "border-ink" : active ? "border-accent" : "border-edge"}`}>
            <div className="flex items-center gap-2"><Marker tone={done ? "ok" : active ? "active" : "wait"} pulse={active && !waiting} /><span className="font-mono text-[10px] text-muted">0{i + 1}</span>{waiting && <Badge value="WAITING FOR YOU" tone="amber" />}</div>
            <div className="mt-1 text-[15px] font-semibold">{st.label}</div>
            <div className="text-[11px] text-muted">{st.sub}</div>
            <div className="mt-1 text-[11px] font-medium">{counts[st.key]}</div>
          </button>
        );
      })}
    </div>
  );
}

function NegotiationChart({ kid }: { kid: Row }) {
  const offers = (kid.offers as Row[]).filter((o) => o.terms.unitPrice != null);
  if (!offers.length) return <div className="text-[12px] text-muted">No priced offer yet.</div>;
  const mand = kid.mandate as Row;
  const max = Math.max(...offers.map((o) => Number(o.terms.unitPrice)), Number(mand.buyerMax ?? 0));
  const cur = String(offers[0]!.terms.currency ?? "");
  const buyerCo = mand.buyerCompanyId;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between"><Cap accent>Negotiation — unit price per offer</Cap>{mand.buyerMax ? <span className="text-[10px] text-muted">buyer mandate max {money(Number(mand.buyerMax), cur)}{mand.supplierMin ? ` · supplier floor ${money(Number(mand.supplierMin), cur)}` : ""}</span> : null}</div>
      <div className="space-y-1.5">
        {(kid.offers as Row[]).map((o) => {
          const price = o.terms.unitPrice as number | null; const buyer = o.from_company_id === buyerCo;
          return (
            <div key={String(o.version)} className="flex items-center gap-2 text-[12px]">
              <span className="w-24 shrink-0 font-mono text-[10px] text-muted">v{o.version} {o.kind.toLowerCase()}</span>
              <div className="relative h-6 flex-1 border border-edge bg-paper">
                {price != null && <div className={`h-full ${buyer ? "bg-faint" : "bg-ink"} ${o.status === "ACCEPTED" ? "!bg-accent" : ""}`} style={{ width: `${Math.max(4, (price / max) * 100)}%` }} />}
                {mand.buyerMax ? <div className="absolute inset-y-0 border-l-2 border-dashed border-alert" style={{ left: `${(Number(mand.buyerMax) / max) * 100}%` }} title="buyer maximum" /> : null}
              </div>
              <span className="w-28 shrink-0 text-right font-semibold tabular-nums">{price != null ? money(price, cur) : "—"}</span>
              <span className="w-20 shrink-0 text-[10px] text-muted">{buyer ? "buyer agent" : "supplier agent"}{o.status === "ACCEPTED" ? " ✓" : ""}</span>
            </div>
          );
        })}
      </div>
      <div className="mt-1 text-[10px] text-muted">Dashed line = buyer's maximum. The agent never goes above it; the accepted offer is highlighted.</div>
    </div>
  );
}

export function Campaign() {
  const { id } = useParams();
  const cid = Number(id);
  const { data, error, reload } = useApi<Row>(`/campaigns/${cid}`, 2000);
  const nav = useNavigate();
  const [tab, setTab] = useState<Stage | null>(null);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState<Row | null>(null);
  const [replyFor, setReplyFor] = useState<number | null>(null);
  const status = data?.mission?.status as string | undefined;
  const report = (data?.mission?.report ?? {}) as Row;
  const shortlist = (report.shortlist ?? []) as Row[];
  useEffect(() => { if (shortlist.length && sel.size === 0) setSel(new Set(shortlist.filter((s) => s.score >= 50).slice(0, 2).map((s) => s.companyId as number))); }, [shortlist.length]); // eslint-disable-line
  const follow = useApi<Row[]>(status && ["IN_EVENT", "INVESTIGATED", "COMPLETE"].includes(status) ? `/campaigns/${cid}/followups` : null, 4000);
  const cur = status ? phaseOf(status) : "BEFORE";
  const shown = tab ?? cur;
  const steps = (data?.steps ?? []) as Row[]; const kids = (data?.children ?? []) as Row[]; const emails = (data?.emails ?? []) as Row[];
  const childSteps = (data?.childSteps ?? []) as Row[];
  const sent = steps.filter((s) => s.kind === "followup");
  const summary = (report.summary ?? null) as Row | null;
  const mailSteps = steps.filter((s) => s.kind === "mail");
  const bySupplier = useMemo(() => { const m = new Map<string, Row[]>(); for (const s of mailSteps) { const k = String((s.detail as Row).supplier ?? "?"); m.set(k, [...(m.get(k) ?? []), s]); } return [...m.entries()]; }, [mailSteps.length]); // eslint-disable-line
  if (error) return <Err msg={error} />;
  if (!data) return <div className="text-muted">Loading…</div>;
  const ev = data.event as Row;
  const when = ev.start_date ? `${String(ev.start_date).slice(0, 10)}${ev.end_date && ev.end_date !== ev.start_date ? ` → ${String(ev.end_date).slice(0, 10)}` : ""}` : "dates not found";
  const waitingKids = kids.filter((k) => k.status === "WAITING_REPLY");
  const dealKids = kids.filter((k) => k.status === "DEAL_CLOSED");
  const act = async (fn: () => Promise<unknown>, ok: string) => { setBusy(true); setMsg(null); try { await fn(); setMsg(ok); reload(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  const attention: { text: string; cta?: string; go?: () => void }[] = [];
  if (status === "INVESTIGATED") attention.push({ text: `Investigation finished (${String(report.verdict?.call ?? "").replace("_", "-")}). Approve which stands your person should visit.`, cta: "Review shortlist", go: () => setTab("BEFORE") });
  if (status !== "COMPLETE") for (const k of waitingKids) attention.push({ text: `${k.person_name ?? "Your person"} has to send a photo and spec from ${k.target_name}.`, cta: "Reply as salesperson", go: () => { setTab("WHILE"); setReplyFor(k.id as number); } });
  if (status === "IN_EVENT" && waitingKids.length === 0 && kids.length > 0) attention.push({ text: "Stands are done. Review and send the follow-ups.", cta: "Open follow-ups", go: () => setTab("AFTER") });
  const counts: Record<Stage, string> = {
    BEFORE: status === "INVESTIGATING" ? `${mailSteps.length} emails so far…` : `${shortlist.length} suppliers contacted · ${mailSteps.length} emails`,
    WHILE: kids.length ? `${kids.length} stand(s) · ${dealKids.length} deal(s)` : "not started",
    AFTER: status === "COMPLETE" ? `${summary?.followupsSent ?? sent.length} follow-ups sent` : "not started",
  };
  return (
    <div className="space-y-5">
      <Link to="/" className="text-xs text-muted hover:text-accent">← Command Center</Link>
      <PageHead title={String(ev.name)} sub={<>📅 {when} · request: “{String(data.mission.prompt)}”</>} actions={<><Badge value={status} /><Link className="text-[12px] text-accent underline-offset-2 hover:underline" to={`/field-events/${ev.id}`}>Event log ›</Link></>} />
      <Stepper status={status ?? ""} tab={shown} setTab={setTab} counts={counts} />

      {attention.length > 0 && (
        <div className="border-l-4 border-accent bg-mist p-4">
          <Cap accent>⚡ Needs you — {attention.length} item(s)</Cap>
          <ul className="space-y-2">{attention.map((a, i) => <li key={i} className="flex flex-wrap items-center justify-between gap-3 text-[13px]"><span>{a.text}</span>{a.cta && <Btn onClick={a.go}>{a.cta}</Btn>}</li>)}</ul>
        </div>
      )}
      {msg && <div className="text-xs text-muted">{msg}</div>}

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          {shown === "BEFORE" && (
            <>
              {report.verdict ? (
                <div className={`border-2 p-4 ${report.verdict.call === "GO" ? "border-ink bg-ink text-on-dark" : report.verdict.call === "MAYBE" ? "border-accent" : "border-alert"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><div className="ds-cap !text-inherit opacity-70">Agents' verdict — is this event worth the trip?</div><div className="text-3xl font-semibold">{String(report.verdict.call).replace("_", "-")}</div></div>
                    <div className="max-w-xl text-[13px]"><ul className="list-disc space-y-0.5 pl-4">{(report.verdict.reasons as string[]).map((r) => <li key={r}>{r}</li>)}</ul></div>
                  </div>
                </div>
              ) : <Card title="Agents are investigating…"><div className="text-[13px] text-muted">They are writing to exhibitors, collecting context and scoring who is worth approaching. The verdict appears here.</div></Card>}

              {shortlist.length > 0 && (
                <Card title="Who is worth approaching — evidence-based shortlist" actions={<span className="text-[11px] text-muted">{sel.size} selected</span>}>
                  <div className="space-y-2">
                    {shortlist.map((s) => (
                      <label key={String(s.companyId)} className={`flex cursor-pointer gap-3 border p-3 ${sel.has(s.companyId as number) ? "border-accent bg-mist" : "border-edge bg-paper"}`}>
                        <input type="checkbox" className="!mt-1 !w-4" disabled={status !== "INVESTIGATED"} checked={sel.has(s.companyId as number)} onChange={() => setSel((p) => { const n = new Set(p); if (n.has(s.companyId as number)) n.delete(s.companyId as number); else n.add(s.companyId as number); return n; })} />
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center justify-between gap-2"><div className="text-sm font-semibold">{s.name} <span className="font-normal text-muted">{s.booth ? `· stand ${s.booth}` : ""}</span></div>
                            <div className="flex items-center gap-2"><Badge value={s.mode === "PUBLIC_RECORD" ? "PUBLIC RECORD" : "OPERATOR PROFILE"} tone="grey" /><span className="font-mono text-sm font-semibold">{s.score}/100</span></div></div>
                          <div className="mt-1 h-1.5 w-full bg-fill"><div className="h-full bg-accent" style={{ width: `${s.score}%` }} /></div>
                          <ul className="mt-2 space-y-0.5 text-[12px]">{(s.why as string[]).map((w) => <li key={w}>✓ {w}</li>)}</ul>
                          <div className="mt-1.5 flex flex-wrap gap-1.5">{(s.unknown as string[]).map((u) => <span key={u} className="border border-dashed border-faint px-1.5 py-0.5 text-[10px] text-muted">? {u}</span>)}</div>
                        </div>
                      </label>
                    ))}
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-edge pt-4">
                    <Btn tone="primary" disabled={busy || status !== "INVESTIGATED" || sel.size === 0} onClick={() => void act(() => api(`/campaigns/${cid}/dispatch`, { body: { companyIds: [...sel] } }).then(() => setTab("WHILE")), "Dispatched — your person is being briefed.")}>{status === "INVESTIGATED" ? `Send my person to ${sel.size} selected stand${sel.size === 1 ? "" : "s"}` : status === "INVESTIGATING" ? "Waiting for the investigation…" : "Already dispatched"}</Btn>
                    <span className="text-[12px] text-muted">Human in the loop: nobody travels until you approve this list. The agents brief your person with what is still unknown per stand.</span>
                  </div>
                </Card>
              )}

              {bySupplier.length > 0 && (
                <Card title={`✉️ Agent conversations — ${mailSteps.length} emails to ${bySupplier.length} exhibitors`}>
                  <div className="space-y-3">
                    {bySupplier.map(([name, list], i) => (
                      <details key={name} open={i === bySupplier.length - 1 && status === "INVESTIGATING"} className="border border-edge">
                        <summary className="cursor-pointer select-none bg-fill px-3 py-2 text-[13px] font-semibold">{name} <span className="font-normal text-muted">· {list.length} emails</span></summary>
                        <div className="space-y-2 p-3">{list.map((s) => <MailBubble key={String(s.id)} t={s.detail as Row} />)}</div>
                      </details>
                    ))}
                  </div>
                </Card>
              )}
              <Card title="🧠 How the agents thought"><ReasoningTrace steps={steps.filter((s) => !["mail", "supplier"].includes(s.kind as string))} data={data} missionId={cid} onContinue={(n) => void nav(`/missions?open=${n}`)} status={status} /></Card>
            </>
          )}

          {shown === "WHILE" && (
            <>
              {kids.length === 0 ? <Empty>Nobody is at the event yet. Approve the shortlist in “Before the event” and your person is briefed per stand.</Empty> : kids.map((k) => {
                const sum = (k.summary ?? {}) as Row; const terms = (sum.terms ?? {}) as Row;
                const ks = childSteps.filter((s) => s.mission_id === k.id);
                const lastThought = [...ks].reverse().find((s) => s.kind === "think");
                const stage = k.status === "DEAL_CLOSED" ? 4 : k.status === "NEGOTIATING" ? 3 : k.fr_status === "REPLIED" ? 2 : 1;
                return (
                  <Card key={String(k.id)} title={<span>➡ {k.target_name} <span className="font-normal text-muted">· stand {k.stand_hint ?? "?"}</span></span>} actions={<><Badge value={String(k.status)} /><Link className="text-[11px] text-accent hover:underline" to={`/missions?open=${k.id}`}>full reasoning ›</Link></>}>
                    <div className="mb-3 flex items-center gap-1">{[0, 1, 2, 3, 4].map((i) => <span key={i} className="flex flex-1 items-center gap-1"><Marker tone={i < stage ? "ok" : i === stage ? "active" : "wait"} pulse={i === stage && stage < 4} />{i < 4 && <span className={`h-px flex-1 ${i < stage ? "bg-ink" : "bg-edge"}`} />}</span>)}</div>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="text-[13px]">
                        <Cap>{k.person_name ?? "Salesperson"} on site</Cap>
                        <div>{k.fr_status === "REPLIED" ? <>Replied {k.replied_at ? clock(String(k.replied_at)) : ""}: photo + spec received.</> : <>Emailed {k.sent_at ? clock(String(k.sent_at)) : ""} — waiting for photo & spec.</>}</div>
                        {k.fr_status === "REPLIED" && <div className="mt-2 text-[12px]"><b>Read from the material:</b> {Object.entries(terms).map(([a, b]) => `${a} ${String(b)}`).join(" · ") || "nothing structured"}{(sum.gaps as string[] | undefined)?.length ? <div className="mt-1 text-muted">Gaps (not guessed): {(sum.gaps as string[]).join("; ")}</div> : null}</div>}
                        {k.status === "WAITING_REPLY" && (replyFor === k.id ? <div className="mt-3"><RepPhone id={k.id as number} onSent={() => reload()} /></div> : <div className="mt-3"><Btn tone="primary" onClick={() => setReplyFor(k.id as number)}>Reply as {k.person_name ?? "salesperson"}</Btn></div>)}
                      </div>
                      <div>{lastThought && <div className="border-l-4 border-accent bg-mist p-3 text-[13px] italic">🧠 {String(((lastThought.detail ?? {}) as Row).text ?? "")}</div>}</div>
                    </div>
                    {(k.offers as Row[]).length > 0 && <div className="mt-4 border-t border-edge pt-3"><NegotiationChart kid={k} /></div>}
                  </Card>
                );
              })}
            </>
          )}

          {shown === "AFTER" && (
            <>
              {summary ? (
                <Card title="📊 Event summary — on the dashboard">
                  <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                    <Stat value={String(summary.suppliersContacted)} label="Suppliers contacted" /><Stat value={String(summary.standsVisited)} label="Stands visited" /><Stat value={String(summary.repliesReceived)} label="Replies in" />
                    <Stat value={<span className="text-accent">{String(summary.dealsClosed)}</span>} label="Deals closed" /><Stat value={<span className="text-accent">{String(summary.humanApprovals)}</span>} label="Human approvals" />
                  </div>
                </Card>
              ) : null}
              {dealKids.map((k) => (
                <Card key={String(k.id)} title={`🤝 Deal ${k.deal_ref} — ${k.target_name}`} actions={<>{k.deal_mode === "SANDBOX" && <Badge value="SANDBOX" tone="amber" />}<Badge value={`${k.human_approvals} human approvals`} tone="green" /></>}>
                  <div className="mb-3 text-[13px]">Total <b>{k.total_value != null ? money(Number(k.total_value), String(k.currency)) : "—"}</b> · a recorded commercial acceptance within both mandates, not a signed contract.</div>
                  <NegotiationChart kid={k} />
                </Card>
              ))}
              {!dealKids.length && <Empty>No deal closed yet. When two agents agree, the deal and the full negotiation appear here.</Empty>}
              <Card title="📤 Follow-ups" actions={status === "COMPLETE" ? <Badge value="SENT" tone="green" /> : <Btn tone="primary" disabled={busy || !status || !["IN_EVENT", "INVESTIGATED"].includes(status)} onClick={() => void act(() => api(`/campaigns/${cid}/followups`, { body: {} }), "Follow-ups sent.")}>Send all follow-ups</Btn>}>
                <p className="mb-3 text-[12px] text-muted">Drafted from what actually happened at each stand: a deal gets next steps, a reply with gaps gets a request for the missing details, no reply gets a nudge, and suppliers you did not visit get a thank-you. You approve before anything leaves.</p>
                <div className="space-y-2">{(status === "COMPLETE" ? sent.map((s) => s.detail as Row) : (follow.data ?? [])).map((d) => (
                  <details key={String(d.tag)} className="border border-edge"><summary className="flex cursor-pointer items-center justify-between gap-2 bg-fill px-3 py-2 text-[13px]"><span><b>{d.name}</b> — {String(d.subject).replace(/^\[[A-Z]+-[\w-]+\]\s*/, "")}</span><Badge value={String(d.kind).replace("_", " ")} tone="grey" /></summary><pre className="whitespace-pre-wrap p-3 font-sans text-[12px] leading-relaxed">{d.body}</pre></details>
                ))}</div>
              </Card>
            </>
          )}
        </div>

        <Card title="📡 Agent activity — every email, logged" actions={data.mailpitUrl ? <a className="text-[11px] text-accent hover:underline" href={String(data.mailpitUrl)} target="_blank" rel="noreferrer noopener">Mailpit ↗</a> : null}>
          <div className="-m-2 max-h-[720px] space-y-0.5 overflow-y-auto p-2">
            {emails.length === 0 && <div className="p-6 text-center text-sm text-muted">Emails appear here as the agents send them.</div>}
            {[...emails].reverse().map((e) => (
              <button key={String(e.id)} className="flex w-full gap-2 border-b border-edge px-2 py-2 text-left text-[12px] hover:bg-fill" onClick={() => void api<Row>(`/agent-emails/${e.id}`).then(setEmail)}>
                <span>{EMAIL_ICON[String(e.kind)] ?? "✉️"}</span>
                <span className="min-w-0 flex-1"><span className="block truncate font-medium">{String(e.subject).replace(/^\[[A-Z]+-[\w-]+\]\s*/, "")}</span><span className="block truncate text-[11px] text-muted">{short(String(e.from_addr))} → {short(String(e.to_addr))}</span></span>
                <span className="shrink-0 text-[10px] text-muted">{clock(String(e.created_at))}</span>
              </button>
            ))}
          </div>
        </Card>
      </div>

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
