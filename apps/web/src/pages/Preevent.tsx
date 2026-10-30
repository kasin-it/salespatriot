import { useState } from "react";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Err, Field } from "../ui.tsx";
import type { Row } from "../types.ts";

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);
const stripBlock = (t: string) => t.replace(/\n*\(Machine-readable block[\s\S]*$/, "").trim();

export function CandidateCard({ d }: { d: Row }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-emerald-300">Known publicly (from sources)</div>
        <ul className="space-y-0.5 text-[12px]">{(d.known as string[]).map((k) => <li key={k}>✓ {k}</li>)}</ul></div>
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"><div className="mb-1 text-xs font-semibold uppercase tracking-wider text-amber-300">Unknown / gated — to be asked</div>
        <ul className="space-y-0.5 text-[12px]">{(d.unknown as string[]).map((k) => <li key={k}>? {k}</li>)}</ul></div>
      <div className="text-[11px] text-muted md:col-span-2">Event: {d.event} · {d.own ? <Badge value="YOUR OWN COMPANY" tone="green" /> : <Badge value="SIMULATED SUPPLIER AGENT" tone="amber" />}</div>
    </div>
  );
}

export function MailBubble({ t }: { t: Row }) {
  const buyer = t.from === "buyer";
  return (
    <div className={`flex ${buyer ? "justify-start" : "justify-end"}`}>
      <div className={`max-w-[92%] rounded-xl border p-3 ${buyer ? "border-sky-500/30 bg-sky-500/10" : "border-violet-500/30 bg-violet-500/10"}`}>
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] uppercase tracking-wider text-muted"><span className={buyer ? "text-sky-300" : "text-violet-300"}>{buyer ? "Buyer agent" : "Supplier agent"}</span><span>→ {buyer ? "supplier" : "buyer"} agent</span>{t.emailed && <Badge value="EMAILED" tone="green" />}{t.readBack && <Badge value="READ FROM MAILBOX" tone="blue" />}</div>
        <div className="mb-1 text-[11px] font-semibold text-slate-300">{t.subject}</div>
        <pre className="whitespace-pre-wrap font-sans text-[12px] leading-relaxed">{stripBlock(t.text as string)}</pre>
      </div>
    </div>
  );
}

export function MeetingCard({ d, missionId, onContinue }: { d: Row; missionId: number; onContinue: (id: number) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => { setBusy(true); setErr(null); try { const r = await api<Row>(`/missions/${missionId}/continue-at-event`, { body: {} }); onContinue(r.id); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  return (
    <div className="rounded-xl border-2 border-sky-400/50 bg-gradient-to-r from-sky-500/15 to-transparent p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="text-lg font-bold text-sky-200">Meeting agreed</div><div className="text-sm">{d.supplier} · {d.event}</div>
          <div className="mt-1 text-sm">🗓 {d.slot ?? "slot tbc"} · 📍 {d.stand ?? "stand tbc"}{d.attendee ? ` · 👤 ${d.attendee.name} (${d.attendee.role})` : ""}</div></div>
        <Btn tone="primary" disabled={busy} onClick={() => void go()}>I'm at the event → send checklist to my salesperson</Btn>
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3 text-[12px]">
        <div><div className="mb-1 text-[10px] uppercase tracking-wider text-muted">They will bring</div>{(d.bringing as string[]).length ? (d.bringing as string[]).map((b) => <div key={b}>• {b}</div>) : <i className="text-muted">not stated</i>}</div>
        <div><div className="mb-1 text-[10px] uppercase tracking-wider text-emerald-300">Learned by email</div>{(d.knownNow as string[]).length ? (d.knownNow as string[]).map((b) => <div key={b}>✓ {b}</div>) : <i className="text-muted">nothing shareable</i>}</div>
        <div><div className="mb-1 text-[10px] uppercase tracking-wider text-amber-300">Only on site (gated)</div>{(d.onSiteOnly as Row[]).map((g) => <div key={g.topic}>? {g.topic} <span className="text-muted">({g.how})</span></div>)}</div>
      </div>
      {err && <div className="mt-2"><Err msg={err} /></div>}
    </div>
  );
}

export function ProfileEditor({ events, onSaved }: { events: Row[]; onSaved: () => void }) {
  const profiles = useApi<Row[]>("/preevent/profiles", 0);
  const [eventId, setEventId] = useState("");
  const [mode, setMode] = useState<"exhibitor" | "own">("exhibitor");
  const [q, setQ] = useState("");
  const exh = useApi<Row>(eventId && mode === "exhibitor" ? `/events/${eventId}/exhibitors?limit=60${q ? `&q=${encodeURIComponent(q)}` : ""}` : null);
  const [companyId, setCompanyId] = useState("");
  const [ownName, setOwnName] = useState("");
  const [f, setF] = useState({ focus: "", stand: "", days: "", attendees: "", bringing: "", shareable: "", gated: "", slots: "" });
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: keyof typeof f) => ({ value: f[k], onChange: (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value }) });
  const load = (p: Row) => {
    const pr = p.profile as Row;
    setEventId(String(pr.event_id ?? "")); setCompanyId(String(p.company_id)); setMode(p.is_registered ? "own" : "exhibitor"); setOwnName(p.is_registered ? p.name : "");
    setF({ focus: pr.focus, stand: pr.stand ?? "", days: pr.days_present ?? "", attendees: (pr.attendees as Row[]).map((a) => `${a.name} — ${a.role}`).join("\n"), bringing: (pr.bringing as string[]).join("\n"), shareable: (pr.shareable as string[]).join("\n"), gated: (pr.gated as Row[]).map((g) => `${g.topic} | ${g.how}`).join("\n"), slots: (pr.meeting_slots as string[]).join("\n") });
  };
  const createOwn = async () => { try { const r = await api<Row>("/preevent/own-company", { body: { name: ownName, country: "PL" } }); setCompanyId(String(r.companyId)); setMsg(`Your supplier company created (#${r.companyId}).`); } catch (e) { setMsg((e as Error).message); } };
  const save = async () => {
    try {
      await api(`/preevent/profiles/${companyId}`, { method: "PUT", body: { eventId: Number(eventId), focus: f.focus, stand: f.stand || null, daysPresent: f.days || null,
        attendees: lines(f.attendees).map((l) => { const [n, ...r] = l.split(/\s+[—-]\s+/); return { name: n!, role: r.join(" — ") || "representative" }; }),
        bringing: lines(f.bringing), shareable: lines(f.shareable), gated: lines(f.gated).map((l) => { const [t, ...h] = l.split("|"); return { topic: t!.trim(), how: h.join("|").trim() || "on site only" }; }), meetingSlots: lines(f.slots) } });
      setMsg("Supplier agent profile saved."); profiles.reload(); onSaved();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Card title="Supplier agent profile — what the supplier's agent is allowed to say">
      <p className="mb-3 text-xs text-muted">The supplier agent answers <b>only</b> from this profile; anything missing is answered “not stated”. Use <b>your own company</b> (you play both sides) or attach a profile to a <b>real exhibitor</b> — then it is a clearly labelled SIMULATION: the facts are yours, not the company's, and are never stored as company data.</p>
      {(profiles.data ?? []).length > 0 && <div className="mb-3 flex flex-wrap gap-2 text-xs"><span className="text-muted">Saved:</span>{(profiles.data ?? []).map((p) => <button key={p.company_id} className="rounded border border-edge px-2 py-0.5 hover:border-accent hover:text-accent" onClick={() => load(p)}>{p.name} {p.is_registered ? "(own)" : "(simulated)"}</button>)}</div>}
      <div className="grid gap-3 md:grid-cols-4">
        <Field label="Event they attend"><select value={eventId} onChange={(e) => setEventId(e.target.value)}><option value="">Select…</option>{events.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></Field>
        <Field label="Supplier is…"><select value={mode} onChange={(e) => { setMode(e.target.value as "exhibitor" | "own"); setCompanyId(""); }}><option value="exhibitor">A real exhibitor (simulated agent)</option><option value="own">My own company (I play both sides)</option></select></Field>
        {mode === "exhibitor" ? (<><Field label="Search exhibitor"><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name…" /></Field>
          <Field label="Exhibitor"><select value={companyId} onChange={(e) => setCompanyId(e.target.value)}><option value="">Select…</option>{(exh.data?.rows as Row[] | undefined)?.filter((x) => x.company_id).map((x) => <option key={x.id} value={x.company_id}>{x.exhibitor_name}</option>)}</select></Field></>)
          : (<><Field label="Name of your supplier company"><input value={ownName} onChange={(e) => setOwnName(e.target.value)} placeholder="e.g. Skyhawk Defence" /></Field><div className="flex items-end"><Btn disabled={!ownName || !!companyId} onClick={() => void createOwn()}>{companyId ? "Created ✓" : "Create it"}</Btn></div></>)}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        <Field label="What they build (focus)"><input {...set("focus")} placeholder="autonomous counter-drone interceptors" /></Field>
        <Field label="Stand"><input {...set("stand")} placeholder="Hall 7, stand 7-123" /></Field>
        <Field label="Days on site"><input {...set("days")} placeholder="1–2 March" /></Field>
        <Field label="Who attends (one per line: Name — Role)"><textarea rows={3} {...set("attendees")} placeholder={"Anna Nowak — CEO\nPiotr Zieliński — CTO"} /></Field>
        <Field label="What they bring (one per line)"><textarea rows={3} {...set("bringing")} placeholder={"Interceptor prototype\nLive demo screen"} /></Field>
        <Field label="Shareable before the event (one per line)"><textarea rows={3} {...set("shareable")} placeholder={"Autonomous interceptor, TRL 6\nField-tested in 2026"} /></Field>
        <Field label="Gated — on site only (Topic | how)"><textarea rows={3} {...set("gated")} placeholder={"Technical specification | NDA, on site\nPricing | on site only"} /></Field>
        <Field label="Meeting slots (one per line)"><textarea rows={3} {...set("slots")} placeholder={"1 March, 14:00\n2 March, 10:30"} /></Field>
      </div>
      <div className="mt-3 flex items-center gap-3"><Btn tone="primary" disabled={!eventId || !companyId || f.focus.length < 5} onClick={() => void save()}>Save profile</Btn>{msg && <span className="text-xs text-muted">{msg}</span>}</div>
    </Card>
  );
}
