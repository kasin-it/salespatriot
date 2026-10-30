import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { api, getToken, useApi } from "../api.ts";
import { Badge, Btn, Cap, Card, Chip, Empty, Err, Field, Marker, Notice, PageHead, Seg, Table, fmtTime } from "../ui.tsx";
import { CandidateCard, MailBubble, MeetingCard, ProfileEditor } from "./Preevent.tsx";
import type { Row } from "../types.ts";

const TERMINAL = ["DEAL_CLOSED", "FAILED", "NO_AGREEMENT", "ESCALATED", "MEETING_PLANNED"];

function Dot({ status }: { status: string }) {
  return <Marker tone={status === "DONE" ? "ok" : status === "ERROR" ? "error" : status === "WAITING" ? "wait" : "active"} pulse={status !== "DONE" && status !== "ERROR"} />;
}

export function Thought({ step, big }: { step: Row; big?: boolean }) {
  const d = step.detail as Row;
  const text = String(d.text ?? "");
  const fresh = Date.now() - Date.parse(String(step.created_at)) < 25000;
  const [n, setN] = useState(fresh ? 0 : text.length);
  useEffect(() => { if (n >= text.length) return; const t = setTimeout(() => setN((x) => Math.min(text.length, x + 2)), 14); return () => clearTimeout(t); }, [n, text.length]);
  const typing = n < text.length;
  return (
    <div className={`border-l-4 border-accent bg-mist ${big ? "p-4" : "p-3"}`}>
      <div className="ds-cap mb-2 flex flex-wrap items-center gap-2"><span className="text-accent">🧠 {step.title}</span><Badge value={d.by === "LLM" ? "AI REASONING · NUMBERS VERIFIED" : "RULE-BASED REASONING"} tone={d.by === "LLM" ? "violet" : "grey"} />{d.note && <span className="normal-case text-muted">{d.note}</span>}</div>
      <p className={`m-0 leading-relaxed text-ink ${big ? "text-[16px]" : "text-[13px]"}`}>{text.slice(0, n)}{typing && <span className="animate-pulse text-accent">▍</span>}</p>
    </div>
  );
}

function useBlobUrl(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let alive = true; let obj: string | null = null;
    void fetch(`/api${path}`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } }).then((r) => r.blob()).then((b) => { if (alive) { obj = URL.createObjectURL(b); setUrl(obj); } }).catch(() => undefined);
    return () => { alive = false; if (obj) URL.revokeObjectURL(obj); };
  }, [path]);
  return url;
}

function ExtractCard({ field }: { field: Row }) {
  const img = (field.attachments as Row[]).find((a) => a.kind === "IMAGE");
  const url = useBlobUrl(img ? `/field/attachments/${img.id}/file` : null);
  const v = img?.extracted?.vision as Row | undefined;
  const sum = field.summary as Row | null;
  const terms = (sum?.terms ?? {}) as Row;
  const gaps = (sum?.gaps ?? []) as string[];
  const row = (label: string, val: ReactNode) => <div className="flex justify-between gap-4 border-b border-edge py-1.5 text-sm"><span className="text-muted">{label}</span><span className="text-right font-medium">{val ?? <i className="font-normal text-muted">not in material</i>}</span></div>;
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="overflow-hidden border border-edge bg-mist">
        {url ? <img src={url} alt="Photo sent from the event" className="max-h-72 w-full object-contain" /> : <div className="grid h-48 place-items-center text-sm text-muted">{img ? "Loading photo…" : "No photo attached"}</div>}
        {img && <div className="border-t border-edge px-3 py-1.5 text-xs text-muted">{img.filename} · <Badge value={img.extraction_status} /></div>}
      </div>
      <div>
        <div className="ds-cap mb-1 flex items-center gap-2 text-accent">Read from the photo and spec {field.fixture && <Badge value="DEMO FIXTURE MATERIAL" tone="amber" />}</div>
        {v?.object_type && <div className="mb-2 bg-mist p-2 text-xs"><Cap>What the photo shows (visual observation, not verified)</Cap><b>{v.object_type}</b>{v.visual_description ? ` — ${v.visual_description}` : ""}</div>}
        {row("Product", v?.product_name ?? (field.attachments as Row[]).find((a) => a.extracted?.categories?.length)?.extracted?.categories?.[0]?.label)}
        {row("Unit price", terms.unitPrice != null ? `${terms.unitPrice} ${terms.currency ?? ""}` : null)}
        {row("Lead time", terms.leadTimeDays != null ? `${terms.leadTimeDays} days` : null)}
        {row("Certifications", ((sum?.certifications ?? []) as Row[]).map((c) => c.name).join(", ") || null)}
        {row("Payment terms", terms.paymentTerms as string | null)}
        {(v?.specs as Row[] | undefined)?.map((s) => row(s.name, s.value))}
        {gaps.length > 0 && <div className="mt-3"><Notice tone="warn"><b>Gaps (not guessed):</b> {gaps.join(" · ")}</Notice></div>}
        {v?.dropped?.length ? <div className="mt-2 text-[11px] text-muted">{v.dropped.length} value(s) the model reported were not visible in its own transcription and were dropped.</div> : null}
      </div>
    </div>
  );
}

function Detail({ step, data, missionId, onContinue }: { step: Row; data: Row; missionId: number; onContinue: (id: number) => void }) {
  const d = step.detail as Row | null;
  if (step.kind === "candidate" && d) return <CandidateCard d={d} />;
  if (step.kind === "mail" && d) return <MailBubble t={d} />;
  if (step.kind === "meeting" && d) return <MeetingCard d={d} missionId={missionId} onContinue={onContinue} />;
  if (step.kind === "parse" && d) return <div className="flex flex-wrap gap-2 text-xs">{d.quantity != null && <Badge value={`${d.quantity} units`} tone="blue" />}<Badge value={d.product} tone="blue" /><Badge value={d.categoryLabel ?? "no category"} tone="violet" />{d.deadline && <Badge value={`deadline ${d.deadline}`} tone="amber" />}<Badge value={`parsed by ${d.parsedBy}`} tone="grey" />{d.note && <span className="text-muted">{d.note}</span>}</div>;
  if (step.kind === "demand" && d) {
    const tender = (n: Row) => <li key={n.id} className="border border-edge px-3 py-2"><a className="font-medium text-accent underline-offset-2 hover:underline hover:text-accent" href={n.url} target="_blank" rel="noreferrer noopener">{String(n.title ?? "notice").slice(0, 110)}</a><div className="text-[11px] text-muted">{n.authority ?? "authority unknown"} · {n.country ?? "?"} · published {n.publicationDate ?? "?"}{n.deadline ? ` · deadline ${String(n.deadline).slice(0, 10)}` : " · deadline not published"} · <Badge value={n.demandClass} /></div></li>;
    return <div className="grid gap-4 lg:grid-cols-2"><div><Cap>Open tenders ({d.totals.open})</Cap><ul className="space-y-1.5">{(d.open as Row[]).map(tender)}</ul>{!(d.open as Row[]).length && <div className="text-xs text-muted">None currently open.</div>}</div><div><Cap>Recent awards — historical, not current demand ({d.totals.awards})</Cap><ul className="space-y-1.5">{(d.awards as Row[]).slice(0, 3).map(tender)}</ul></div></div>;
  }
  if (step.kind === "rank" && d) return <Table rows={d.ranking} cols={[{ h: "Event", r: (e) => <b>{e.name}</b> }, { h: "Dates", r: (e) => e.startDate ?? "?" }, { h: "Matching exhibitors", r: (e) => <span><b className="text-accent">{e.matching}</b> <span className="text-[11px] text-muted">({e.specific} exact)</span></span> }, { h: "of", r: (e) => e.exhibitors }, { h: "Fits deadline", r: (e) => e.fitsDeadline === true ? <Badge value="YES" tone="green" /> : e.fitsDeadline === false ? <Badge value="NO" tone="red" /> : "—" }, { h: "e.g.", r: (e) => <span className="text-[11px] text-muted">{(e.examples as string[]).join(", ")}</span> }]} />;
  if (step.kind === "plan" && d) return <div className="grid gap-3 md:grid-cols-3">{(d.plan as Row[]).map((p, i) => <div key={p.exhibitorId} className="ds-chamfer ds-chamfer--sm bg-mist p-3"><Cap accent>STAND #{i + 1}</Cap><div className="font-semibold">{p.name}</div><div className="text-xs text-muted">{p.booth ? `Stand ${p.booth}` : "stand n/a"} · {p.country ?? "?"}</div>{p.evidence && <div className="mt-2 text-[11px] italic text-muted">“{String(p.evidence).slice(0, 150)}”</div>}{p.website && <a className="mt-1 block truncate text-[11px] text-accent underline-offset-2 hover:underline hover:text-accent" href={p.website} target="_blank" rel="noreferrer noopener">{p.website}</a>}</div>)}</div>;
  if (step.kind === "extract" && data.field) return <ExtractCard field={data.field as Row} />;
  if (step.kind === "briefing" && d) return <div className="space-y-1 text-sm"><div>{d.fit.priceVsMandate}</div><div>{d.fit.leadTimeVsMandate}</div>{d.matchedNotices.length > 0 && <div className="text-xs">Matching open tenders: {(d.matchedNotices as Row[]).map((n) => <a key={n.id} className="mr-3 text-accent underline-offset-2 hover:underline hover:text-accent" href={n.url} target="_blank" rel="noreferrer noopener">{String(n.title ?? "notice").slice(0, 60)}{n.country ? ` (${n.country})` : ""}</a>)}</div>}{d.buyerMandate && <div className="text-xs text-muted">Mandate: max {d.buyerMandate.maxUnitPrice} {d.buyerMandate.currency}, lead ≤ {d.buyerMandate.maxLeadTimeDays} d, payment {d.buyerMandate.allowedPaymentTerms}</div>}</div>;
  if (step.kind === "rounds") return <div className="space-y-2"><Table rows={data.offers as Row[]} cols={[{ h: "v", r: (o) => o.version }, { h: "Kind", r: (o) => o.kind }, { h: "From", r: (o) => (o.from_company_id === (data.negotiation as Row)?.buyer_company_id ? "Buyer agent" : "Supplier agent") }, { h: "Unit price", r: (o) => <b>{o.terms.unitPrice ?? "—"} {o.terms.currency}</b> }, { h: "Lead", r: (o) => (o.terms.leadTimeDays != null ? `${o.terms.leadTimeDays} d` : "—") }, { h: "Status", r: (o) => <Badge value={o.status} /> }]} /><ul className="text-[11px] text-muted">{(d?.log as string[] | undefined)?.map((l, i) => <li key={i}>• {l}</li>)}</ul></div>;
  return null;
}

function MailPanel({ missionId, mailpitUrl, active }: { missionId: number; mailpitUrl: string | null; active: boolean }) {
  const list = useApi<Row>(`/missions/${missionId}/emails`, active ? 2000 : 0);
  const [open, setOpen] = useState<string | null>(null);
  const msg = useApi<Row>(open ? `/missions/${missionId}/emails/${open}` : null);
  return (
    <Card title="Mailbox (real emails)" actions={mailpitUrl ? <a className="text-xs text-accent underline-offset-2 hover:underline hover:text-accent" href={mailpitUrl} target="_blank" rel="noreferrer noopener">Open Mailpit ↗</a> : null}>
      {!list.data?.configured && <div className="text-sm text-muted">Mailpit is not configured.</div>}
      <ul className="space-y-1.5">
        {(list.data?.messages as Row[] | undefined)?.map((m) => (
          <li key={m.id}><button className={`w-full border px-3 py-2 text-left text-[12px] transition ${open === m.id ? "border-accent bg-fill" : "border-edge hover:border-faint"}`} onClick={() => setOpen(open === m.id ? null : m.id)}>
            <div className="truncate font-semibold">{m.subject}</div><div className="flex justify-between text-[11px] text-muted"><span>{m.from} → {m.to}</span><span className="font-mono">{m.attachments ? `Att. ${m.attachments}` : ""} {fmtTime(m.created)?.split(", ")[1]}</span></div></button>
            {open === m.id && msg.data && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap bg-mist p-3 text-[11px] leading-relaxed">{msg.data.text}{msg.data.attachments?.length ? `\n\nAttachments: ${msg.data.attachments.join(", ")}` : ""}</pre>}</li>
        ))}
      </ul>
      {list.data?.messages?.length === 0 && <div className="text-sm text-muted">No emails yet.</div>}
    </Card>
  );
}

export function DealBanner({ data }: { data: Row }) {
  const d = data.deal as Row;
  const open = async () => { const r = await fetch(`/api/deals/${d.id}/pdf`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } }); window.open(URL.createObjectURL(await r.blob()), "_blank"); };
  const sandbox = d.mode === "SANDBOX";
  return (
    <div>
      <div className="ds-banner">
        <div className="min-w-0 flex-1 normal-case">
          <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
            <div><div className="text-2xl">DEAL CLOSED</div><div className="flex items-center gap-2 text-sm font-normal">{d.deal_ref} · {d.total_value != null ? `${d.total_value.toLocaleString()} ${d.currency}` : "value unknown"}{sandbox && <Badge value="SANDBOX" tone="blue" />}</div></div>
        <div className="flex items-center gap-6 text-center"><div className="ds-stat"><div className="ds-stat__value tabular-nums">{d.humanApprovals}</div><div className="ds-stat__label text-on-dark-muted">human approvals</div></div><div className="ds-stat"><div className="ds-stat__value tabular-nums">{d.pendingApprovals}</div><div className="ds-stat__label text-on-dark-muted">in approval queue</div></div><Btn tone="primary" onClick={() => void open()}>Open deal PDF</Btn></div>
          </div>
          {sandbox && <div className="mt-3 border-l-2 border-on-dark-muted pl-3 text-xs font-normal text-on-dark">Sandbox run: the supplier agent acts on a mandate entered by the operator. A recorded acceptance, not a signed contract.</div>}
        </div>
      </div>
      <details className="bg-paper px-4 py-3 text-xs"><summary className="ds-cap cursor-pointer">Ledger ({(d.ledger as Row[]).length} entries)</summary><ul className="mt-2 space-y-0.5 text-muted">{(d.ledger as Row[]).map((l, i) => <li key={i}><span className="font-mono">{fmtTime(l.created_at)?.split(", ")[1]}</span> · {l.action} · {l.summary}</li>)}</ul></details>
    </div>
  );
}

export function RepPhone({ id, onSent }: { id: number; onSent: () => void }) {
  const [files, setFiles] = useState<{ name: string; type: string; base64: string }[]>([]);
  const [note, setNote] = useState("Jestem przy stoisku. Zdjęcie i spec w załączniku.");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (list: FileList | null) => {
    const out: typeof files = [];
    for (const f of Array.from(list ?? [])) {
      const buf = new Uint8Array(await f.arrayBuffer()); let bin = ""; for (const b of buf) bin += String.fromCharCode(b);
      out.push({ name: f.name, type: f.type || "application/octet-stream", base64: btoa(bin) });
    }
    setFiles(out);
  };
  const send = async (useDemoAssets: boolean, set: "thermal" | "drone" = "thermal") => { setBusy(true); setMsg(null); try { await api(`/missions/${id}/rep-reply`, { body: { note, files: useDemoAssets ? [] : files, useDemoAssets, set } }); setMsg("Reply sent by email. The agent is reading it…"); onSent(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); } };
  return (
    <Card title="Reply as the salesperson">
      <p className="mb-2 text-xs text-muted">The salesperson is only a camera: attach your photo and the spec. This sends a real email from their address; replying from any mail client to the same subject works too.</p>
      <input type="file" multiple accept="image/*,.pdf,.txt" onChange={(e) => void pick(e.target.files)} />
      {files.length > 0 && <div className="mt-1 text-[11px] text-muted">{files.map((f) => f.name).join(", ")}</div>}
      <textarea className="mt-2" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      <div className="mt-2 flex flex-wrap items-center gap-2"><Btn tone="primary" disabled={busy || (!files.length && !note.trim())} onClick={() => void send(false)}>Send reply</Btn>{msg && <span className="text-xs text-muted">{msg}</span>}</div>
      <details className="mt-3 text-xs text-muted"><summary className="cursor-pointer">Fallback files (watermarked fixtures)</summary><div className="mt-2 flex gap-2"><Btn disabled={busy} onClick={() => void send(true, "thermal")}>Thermal camera set</Btn><Btn disabled={busy} onClick={() => void send(true, "drone")}>Drone set</Btn></div></details>
    </Card>
  );
}

const PHASES = [
  { key: "understand", label: "Understand", hint: "what you asked for" },
  { key: "market", label: "Read the market", hint: "real tenders" },
  { key: "choose", label: "Choose", hint: "event, stands, supplier" },
  { key: "contact", label: "Contact", hint: "emails & people" },
  { key: "learn", label: "Learn on site", hint: "photo & spec" },
  { key: "negotiate", label: "Negotiate", hint: "agent to agent" },
  { key: "close", label: "Close", hint: "deal record" },
] as const;
const KIND_PHASE: Record<string, string> = { event_fit: "choose", candidates: "choose", supplier: "contact", supplier_context: "contact", verdict: "choose", dispatch: "contact", debrief: "learn", followup: "close", summary: "close", start: "understand", parse: "understand", demand: "market", rank: "choose", choose: "choose", plan: "choose", candidate: "choose", email: "contact", wait: "contact", mail: "contact", meeting: "contact", extract: "learn", briefing: "learn", negotiate: "negotiate", rounds: "negotiate", deal: "close" };
const THINK_PHASE: Record<string, string> = { "How I read your request": "understand", "What the tenders tell me": "market", "Why this event": "choose", "Why these stands": "choose", "Why I'm asking their agent": "choose", "What the conversation gave me": "contact", "What the salesperson's material tells me": "learn", "How the negotiation went": "negotiate" };
const OPEN_KINDS = ["mail", "meeting", "extract", "candidate", "deal", "rounds"];

function PhaseRail({ states }: { states: Record<string, "done" | "active" | "error" | "pending"> }) {
  return (
    <div className="mb-5 grid grid-cols-7 gap-1">
      {PHASES.map((p, i) => {
        const st = states[p.key] ?? "pending";
        return (
          <div key={p.key} className={`border-t-2 pt-2 ${st === "pending" ? "border-edge" : st === "error" ? "border-alert" : st === "active" ? "border-accent" : "border-ink"}`}>
            <div className="flex items-center gap-1.5"><Marker tone={st === "done" ? "ok" : st === "error" ? "error" : st === "active" ? "active" : "wait"} pulse={st === "active"} /><span className="font-mono text-[10px] text-muted">0{i + 1}</span></div>
            <div className={`mt-0.5 text-[12px] font-semibold leading-tight ${st === "pending" ? "text-faint" : "text-ink"}`}>{p.label}</div>
            <div className="hidden text-[10px] text-muted md:block">{p.hint}</div>
          </div>
        );
      })}
    </div>
  );
}

export function ReasoningTrace({ steps, data, missionId, onContinue, status }: { steps: Row[]; data: Row; missionId: number; onContinue: (id: number) => void; status: string | undefined }) {
  const groups: { key: string; thoughts: Row[]; actions: Row[] }[] = [];
  let last = "understand";
  for (const s of steps) {
    const key = s.kind === "think" ? THINK_PHASE[s.title as string] ?? last : s.kind === "error" ? last : KIND_PHASE[s.kind as string] ?? last;
    last = key;
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, thoughts: [], actions: [] }; groups.push(g); }
    (s.kind === "think" ? g.thoughts : g.actions).push(s);
  }
  const terminal = !!status && TERMINAL.includes(status);
  const lastKey = groups.at(-1)?.key;
  const failed = status === "FAILED" || status === "NO_AGREEMENT" || status === "ESCALATED";
  const states: Record<string, "done" | "active" | "error" | "pending"> = {};
  for (const g of groups) states[g.key] = g.key === lastKey ? (failed ? "error" : terminal ? "done" : "active") : "done";
  return (
    <div>
      <PhaseRail states={states} />
      <div className="space-y-6">
        {groups.map((g) => {
          const ph = PHASES.find((p) => p.key === g.key)!;
          const idx = PHASES.findIndex((p) => p.key === g.key) + 1;
          const isActive = g.key === lastKey && !terminal;
          return (
            <section key={g.key} className="ds-reveal">
              <header className="mb-2 flex items-center gap-2"><span className="font-mono text-[11px] text-accent">0{idx}</span><h3 className="ds-label m-0">{ph.label}</h3><span className="h-px flex-1 bg-edge" /></header>
              <div className="space-y-3">
                {g.thoughts.map((t) => <Thought key={String(t.id)} step={t} big />)}
                {g.actions.map((a) => {
                  const hasDetail = !!a.detail && a.kind !== "start";
                  const open = isActive || OPEN_KINDS.includes(a.kind as string);
                  return (
                    <div key={String(a.id)} className="pl-1">
                      <div className="flex items-start gap-2"><span className="mt-1.5"><Dot status={a.status as string} /></span>
                        <div className="min-w-0 flex-1"><div className={`text-[13px] ${a.status === "ERROR" ? "font-semibold text-alert" : "text-ink"}`}>{a.title}</div></div>
                        <div className="shrink-0 font-mono text-[10px] text-muted">{fmtTime(a.created_at as string)?.split(", ")[1]}</div></div>
                      {hasDetail && (
                        <details open={open} className="group ml-5 mt-1">
                          <summary className="ds-cap cursor-pointer select-none list-none py-1 text-muted hover:text-accent">▸ Evidence</summary>
                          <div className="pb-2 pt-1"><Detail step={a} data={data} missionId={missionId} onContinue={onContinue} /></div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function MissionView({ id, onContinue }: { id: number; onContinue: (id: number) => void }) {
  const [live, setLive] = useState(true);
  const m = useApi<Row>(`/missions/${id}`, live ? 1500 : 0);
  const status = m.data?.mission?.status as string | undefined;
  useEffect(() => { if (status && TERMINAL.includes(status)) setLive(false); }, [status]);
  const end = useRef<HTMLDivElement>(null);
  const n = (m.data?.steps as Row[] | undefined)?.length ?? 0;
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [n]);
  if (!m.data) return <div className="text-muted">Loading…</div>;
  const steps = m.data.steps as Row[];
  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
      <div className="space-y-4">
        {m.data.mission.event_id ? <div className="flex items-center justify-between border border-edge bg-paper px-3 py-2 text-[12px]"><span className="text-muted">This run belongs to an event</span><Link className="text-accent underline-offset-2 hover:underline" to={`/field-events/${m.data.mission.event_id}`}>Open the event log — who is there, every email ›</Link></div> : null}
        {m.data.deal && <DealBanner data={m.data} />}
        <Card title={<span>How the agent thinks <Badge value={status} /></span>}>
          <ReasoningTrace steps={steps} data={m.data} missionId={id} onContinue={onContinue} status={status} />
          <div ref={end} />
        </Card>
      </div>
      <div className="space-y-4">{status === "WAITING_REPLY" && <RepPhone id={id} onSent={() => m.reload()} />}<MailPanel missionId={id} mailpitUrl={m.data.mailpitUrl} active={live} /></div>
    </div>
  );
}

const SUGGEST: Record<string, Record<string, string>> = {
  default: { b_currency: "EUR", b_max: "1300", b_lead: "60", b_pay: "net30,net45", s_min: "1150", s_open: "1500", s_lead: "42", s_pay: "net30", s_del: "DAP", s_valid: "14" },
  drone: { b_currency: "EUR", b_max: "16000", b_lead: "90", b_pay: "net30,net45", s_min: "14000", s_open: "18000", s_lead: "70", s_pay: "net30", s_del: "DAP", s_valid: "14" },
};
function Setup({ onDone, setup }: { onDone: () => void; setup: Row }) {
  const [profile, setProfile] = useState<"default" | "drone">("default");
  const init = (p: "default" | "drone"): Record<string, string> => {
    const m = setup.mandates?.[p]; const sg: Record<string, string> = { b_currency: "EUR", b_pay: "net30,net45", s_pay: "net30", s_del: "DAP", s_valid: "14", b_max: "", b_lead: "", s_min: "", s_open: "", s_lead: "" };
    return { legalName: setup.company?.name ?? "", country: setup.company?.country ?? "PL", repName: setup.rep?.name ?? "", repEmail: setup.rep?.email ?? "", deliveryLocation: setup.deliveryLocation ?? "Warsaw, Poland",
      b_currency: m?.buyer.currency ?? sg.b_currency!, b_max: String(m?.buyer.max_unit_price ?? sg.b_max), b_lead: String(m?.buyer.max_lead_time_days ?? sg.b_lead), b_pay: m?.buyer.allowed_payment_terms ?? sg.b_pay!,
      s_min: String(m?.supplier.min_unit_price ?? sg.s_min), s_open: String(m?.supplier.opening_unit_price ?? sg.s_open), s_lead: String(m?.supplier.opening_lead_time_days ?? sg.s_lead), s_pay: m?.supplier.opening_payment_terms ?? sg.s_pay!, s_del: m?.supplier.opening_delivery_terms ?? sg.s_del!, s_valid: String(m?.supplier.opening_validity_days ?? sg.s_valid) };
  };
  const [f, setF] = useState<Record<string, string>>(init("default"));
  const [err, setErr] = useState<string | null>(null);
  const switchTo = (p: "default" | "drone") => { setProfile(p); setF((cur) => ({ ...init(p), legalName: cur.legalName ?? "", country: cur.country ?? "PL", repName: cur.repName ?? "", repEmail: cur.repEmail ?? "", deliveryLocation: cur.deliveryLocation ?? "" })); };
  const set = (k: string) => ({ value: String(f[k] ?? ""), placeholder: SUGGEST[profile]?.[k] ? `e.g. ${SUGGEST[profile]![k]}` : "", onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const saved = (p: string) => !!setup.mandates?.[p];
  const save = async () => {
    try {
      await api("/demo/setup", { method: "PUT", body: { profile, buyer: { legalName: f.legalName, country: (f.country ?? "").toUpperCase() }, deliveryLocation: f.deliveryLocation, rep: { name: f.repName, email: f.repEmail },
        buyerMandate: { currency: f.b_currency, max_unit_price: Number(f.b_max), opening_unit_price: Number(f.b_max) * 0.8, max_lead_time_days: Number(f.b_lead), allowed_payment_terms: f.b_pay },
        supplierMandate: { currency: f.b_currency, min_unit_price: Number(f.s_min), opening_unit_price: Number(f.s_open), opening_lead_time_days: Number(f.s_lead), opening_payment_terms: f.s_pay, opening_delivery_terms: f.s_del, opening_validity_days: Number(f.s_valid) } } });
      onDone();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card title="Demo setup — mandates the agents may act within (entered once, before the show)">
      <div className="mb-4 flex flex-wrap items-center gap-2">{([["default", "Thermal camera / default mandates"], ["drone", "Military drone mandates"]] as const).map(([k, l]) => <Seg key={k} active={profile === k} onClick={() => switchTo(k)}>{l} {saved(k) ? "✓" : ""}</Seg>)}<span className="text-[11px] text-muted">Each profile has its own price scale. Grey hints are examples only.</span></div>
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-2"><Cap accent>Your company &amp; salesperson (shared)</Cap>
          <Field label="Your company (buyer)"><input {...set("legalName")} /></Field><Field label="Country (ISO-2)"><input {...set("country")} /></Field><Field label="Delivery location"><input {...set("deliveryLocation")} /></Field>
          <Field label="Salesperson at the event — name"><input {...set("repName")} /></Field><Field label="Salesperson email"><input {...set("repEmail")} /></Field></div>
        <div className="space-y-2"><Cap accent>Buyer mandate ({profile})</Cap>
          <Field label="Currency"><input {...set("b_currency")} /></Field><Field label="Max unit price"><input {...set("b_max")} /></Field><Field label="Max lead time (days)"><input {...set("b_lead")} /></Field><Field label="Allowed payment terms"><input {...set("b_pay")} /></Field>
          <p className="text-[11px] text-muted">The buyer opens at 80% of the maximum and concedes within it.</p></div>
        <div className="space-y-2"><Cap accent>Simulated supplier mandate (SANDBOX, {profile})</Cap>
          <Field label="Min unit price"><input {...set("s_min")} /></Field><Field label="Opening unit price"><input {...set("s_open")} /></Field><Field label="Opening lead time (days)"><input {...set("s_lead")} /></Field>
          <div className="grid grid-cols-3 gap-2"><Field label="Payment"><input {...set("s_pay")} /></Field><Field label="Delivery"><input {...set("s_del")} /></Field><Field label="Valid (d)"><input {...set("s_valid")} /></Field></div>
          <p className="text-[11px] text-muted">Applied to whichever real company the agent picks. Flagged as simulated; never a real company's offer.</p></div>
      </div>
      <div className="mt-4 flex items-center gap-3"><Btn tone="primary" onClick={() => void save()} disabled={!f.legalName || !f.repEmail || !f.b_max || !f.s_min || !f.s_open}>Save {profile} setup</Btn><Err msg={err} /></div>
    </Card>
  );
}

export function Mission() {
  const setup = useApi<Row>("/demo/setup", 8000);
  const missions = useApi<Row[]>("/missions", 4000);
  const [sp] = useSearchParams();
  const [sel, setSel] = useState<number | null>(Number(sp.get("open")) || null);
  useEffect(() => { const o = Number(sp.get("open")); if (o) setSel(o); }, [sp]);
  const [showSetup, setShowSetup] = useState(false);
  const s = setup.data;
  const chip = (ok: boolean | undefined, label: string) => <Badge value={`${ok ? "● " : "○ "}${label}`} tone={ok ? "green" : "amber"} />;
  return (
    <div className="space-y-5">
      <Link to="/" className="text-xs text-muted hover:text-accent">← Command Center</Link>
      <PageHead title="Missions" sub="The reasoning behind every run. New runs start from the Command Center."
        actions={<>{chip(s?.status.mailpitReachable, "Mailpit")}{chip(s?.status.vision, "Photo reading")}{chip(s?.status.llm, "LLM")}{chip(s?.ready, "Setup")}<Btn onClick={() => setShowSetup(!showSetup)}>{showSetup ? "Hide setup" : "Setup"}</Btn></>} />
      {s && (!s.ready || showSetup) && <Setup setup={s} onDone={() => { setup.reload(); setShowSetup(false); }} />}
      {showSetup && <details className="border border-edge bg-paper p-3"><summary className="ds-cap cursor-pointer">Supplier agent profile (advanced)</summary><div className="mt-3"><ProfileEditor events={s?.events ?? []} onSaved={() => undefined} /></div></details>}
      {(missions.data ?? []).length > 0 && <div className="flex flex-wrap items-center gap-2 text-xs"><span className="text-muted">Runs:</span>{(missions.data ?? []).slice(0, 10).map((x) => <Chip key={String(x.id)} active={x.id === sel} onClick={() => setSel(x.id as number)}>#{x.id} · {String(x.status).replace(/_/g, " ").toLowerCase()}</Chip>)}</div>}
      {sel ? <MissionView key={sel} id={sel} onContinue={(nid) => { setSel(nid); missions.reload(); }} />
        : <Empty>Pick a run above, or start a new one from the <Link className="text-accent underline-offset-2 hover:underline" to="/">Command Center</Link>.</Empty>}
    </div>
  );
}
