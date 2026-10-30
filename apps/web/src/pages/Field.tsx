import { useState } from "react";
import { Link } from "react-router";
import { api, getToken, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field as F, Table, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

function DealBanner({ dealId }: { dealId: number }) {
  const d = useApi<Row>(`/deals/${dealId}`);
  if (!d.data) return null;
  const deal = d.data.deal as Row;
  const sandbox = deal.mode === "SANDBOX";
  const open = async () => {
    const res = await fetch(`/api/deals/${dealId}/pdf`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
    window.open(URL.createObjectURL(await res.blob()), "_blank");
  };
  return (
    <div className="rounded-lg border border-emerald-500/50 bg-emerald-500/15 p-4">
      <div className="text-lg font-bold text-emerald-300">DEAL CLOSED{sandbox ? " — SANDBOX SIMULATION" : ""}</div>
      <div className="mt-1 text-sm">{deal.deal_ref} · {deal.total_value != null ? `${deal.total_value} ${deal.currency}` : "value unknown"} · human approvals: <b>{d.data.humanApprovals}</b></div>
      {sandbox && <div className="mt-1 text-xs text-amber-200">The supplier side is a simulated agent with an operator-configured mandate. Not a real transaction and not a signed contract.</div>}
      <div className="mt-2 flex gap-2"><Btn onClick={() => void open()}>Open deal PDF</Btn><Link className="text-xs text-sky-300 underline" to={`/negotiations/${deal.negotiation_id}`}>Negotiation history &amp; ledger</Link></div>
    </div>
  );
}

export function FieldAgent() {
  const me = useApi<Row>("/me");
  const vision = useApi<Row>("/vision/status");
  const companies = useApi<Row>("/companies?limit=500");
  const events = useApi<Row[]>("/events");
  const [cid, setCid] = useState<number | null>(null);
  const companyId = cid ?? me.data?.companies?.[0]?.id ?? null;
  const reqs = useApi<Row>(companyId ? `/field/requests?companyId=${companyId}` : null, 3000);
  const [rep, setRep] = useState({ name: "", email: "" });
  const [f, setF] = useState({ repId: "", eventId: "", targetCompanyId: "", standHint: "", quantity: "", deliveryLocation: "", auto: true });
  const [m, setM] = useState({ currency: "EUR", min_unit_price: "", opening_unit_price: "", opening_lead_time_days: "", opening_payment_terms: "net30", opening_delivery_terms: "DAP", opening_validity_days: "14" });
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); setMsg(ok); reqs.reload(); } catch (e) { setMsg((e as Error).message); } };
  if (me.data && !me.data.companies.length) return <Empty>Register a company in Settings to use the Field Agent.</Empty>;
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-bold">Field Agent</h1><p className="text-sm text-muted">The agent writes to a person at the event and asks for a photo, the specification and the product presentation. Everything after the reply is autonomous.</p></div>
      <Err msg={msg} />
      <Card title="Setup status">
        <div className="flex flex-wrap gap-4 text-xs"><span>Photo reading (vision): {vision.data?.configured ? <Badge value="CONNECTED" /> : <Badge value="NOT_CONFIGURED" />} {vision.data?.configured && <span className="text-muted">{vision.data.provider} · {vision.data.model}</span>}</span>
          <span className="text-muted">Without a vision key, photos are stored as evidence but nothing is read from them. Set OPENAI_API_KEY (or ANTHROPIC_API_KEY).</span></div>
        <select className="mt-3 !w-72" value={companyId ?? ""} onChange={(e) => setCid(Number(e.target.value))}>{(me.data?.companies ?? []).map((c: Row) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="1. Person at the event">
          <div className="grid gap-3 md:grid-cols-3"><F label="Name"><input value={rep.name} onChange={(e) => setRep({ ...rep, name: e.target.value })} /></F><F label="Email"><input value={rep.email} onChange={(e) => setRep({ ...rep, email: e.target.value })} /></F>
            <div className="flex items-end"><Btn disabled={!rep.name || !rep.email} onClick={() => void run(() => api("/field/reps", { body: { companyId, ...rep } }), "Person saved")}>Add</Btn></div></div>
          <div className="mt-2 text-xs text-muted">{(reqs.data?.reps ?? []).map((r: Row) => `${r.name} <${r.email}>`).join(" · ") || "No people added yet."}</div>
        </Card>
        <Card title="2. Simulated supplier mandate (SANDBOX only)">
          <p className="mb-2 text-[11px] text-muted">For a public company record that has no account. Stored as <b>simulated</b>, never used in REAL negotiations, never presented as that company's real offer. Set it before the demo.</p>
          <div className="grid gap-2 md:grid-cols-4">{(["min_unit_price", "opening_unit_price", "opening_lead_time_days", "currency", "opening_payment_terms", "opening_delivery_terms", "opening_validity_days"] as const).map((k) => <F key={k} label={k.replace(/_/g, " ")}><input value={m[k]} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></F>)}</div>
          <div className="mt-2"><Btn disabled={!f.targetCompanyId || !m.min_unit_price || !m.opening_unit_price || !m.opening_lead_time_days} onClick={() => void run(() => api(`/sandbox/companies/${f.targetCompanyId}/mandate`, { method: "PUT", body: { currency: m.currency, min_unit_price: Number(m.min_unit_price), opening_unit_price: Number(m.opening_unit_price), opening_lead_time_days: Number(m.opening_lead_time_days), opening_payment_terms: m.opening_payment_terms, opening_delivery_terms: m.opening_delivery_terms, opening_validity_days: Number(m.opening_validity_days) } }), "Simulated mandate saved for the selected target company")}>Save for target company (select it in step 3)</Btn></div>
        </Card>
      </div>
      <Card title="3. Ask the person">
        <div className="grid gap-3 md:grid-cols-4">
          <F label="Person"><select value={f.repId} onChange={(e) => setF({ ...f, repId: e.target.value })}><option value="">Select…</option>{(reqs.data?.reps ?? []).map((r: Row) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></F>
          <F label="Event"><select value={f.eventId} onChange={(e) => setF({ ...f, eventId: e.target.value })}><option value="">—</option>{(events.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></F>
          <F label="Target company (stand)"><select value={f.targetCompanyId} onChange={(e) => setF({ ...f, targetCompanyId: e.target.value })}><option value="">—</option>{(companies.data?.rows ?? []).map((c: Row) => <option key={c.id} value={c.id}>{c.canonical_name}</option>)}</select></F>
          <F label="Stand hint"><input value={f.standHint} onChange={(e) => setF({ ...f, standHint: e.target.value })} placeholder="hall 2, A12" /></F>
          <F label="RFQ quantity"><input value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></F>
          <F label="Delivery location"><input value={f.deliveryLocation} onChange={(e) => setF({ ...f, deliveryLocation: e.target.value })} /></F>
          <label className="mt-5 flex items-center gap-2 text-xs md:col-span-2"><input className="!w-auto" type="checkbox" checked={f.auto} onChange={(e) => setF({ ...f, auto: e.target.checked })} />After the reply, negotiate and close autonomously (SANDBOX)</label>
        </div>
        <div className="mt-3"><Btn tone="primary" disabled={!f.repId} onClick={() => void run(() => api("/field/requests", { body: { companyId, repId: Number(f.repId), eventId: f.eventId ? Number(f.eventId) : undefined, targetCompanyId: f.targetCompanyId ? Number(f.targetCompanyId) : undefined, standHint: f.standHint || undefined, autoNegotiate: f.auto, rfqTerms: { quantity: f.quantity ? Number(f.quantity) : null, deliveryLocation: f.deliveryLocation || null } } }), "Request queued — the agent will email the person")}>Send request</Btn></div>
      </Card>
      {(reqs.data?.rows ?? []).map((r: Row) => (
        <Card key={r.id} title={`Request ${r.token} → ${r.rep_name}`} actions={<Badge value={r.status} />}>
          <div className="space-y-3 text-[13px]">
            <div className="text-xs text-muted">Sent {fmtTime(r.sent_at) ?? "not sent"} · {r.mode}{r.error ? <span className="text-red-300"> · {r.error}</span> : null}{r.replied_at ? ` · replied ${fmtTime(r.replied_at)}` : " · waiting for the person's reply"}</div>
            {r.deal_id && <DealBanner dealId={r.deal_id} />}
            {r.attachments.length > 0 && <Table rows={r.attachments} cols={[{ h: "File", r: (a) => a.filename }, { h: "Kind", r: (a) => a.kind }, { h: "Reading", r: (a) => <Badge value={a.extraction_status} /> }, { h: "Extracted", r: (a) => a.extracted ? <span className="text-[11px]">{a.extracted.vision?.product_name ? `${a.extracted.vision.product_name} · ` : ""}price {a.extracted.terms.unitPrice ?? "?"} {a.extracted.terms.currency ?? ""} · lead {a.extracted.terms.leadTimeDays ?? "?"} d · certs {a.extracted.certifications.map((c: Row) => c.name).join(", ") || "none"}{a.extracted.vision?.dropped?.length ? <span className="text-amber-200"> · {a.extracted.vision.dropped.length} unverifiable value(s) dropped</span> : null}</span> : "—" }]} />}
            {r.briefing && (
              <div className="rounded border border-edge p-3">
                <div className="mb-1 text-xs uppercase text-muted">Briefing</div>
                <div>{r.briefing.fit.priceVsMandate} · {r.briefing.fit.leadTimeVsMandate}</div>
                <div className="text-amber-200/90">Gaps: {r.briefing.fromMaterial.gaps.join("; ") || "none"}</div>
                <div className="mt-1">Matching open notices: {r.briefing.matchedNotices.length ? r.briefing.matchedNotices.map((n: Row) => <a key={n.id} className="mr-3 text-sky-300 underline" href={n.url} target="_blank" rel="noreferrer noopener">{(n.title ?? "notice").slice(0, 50)}</a>) : "none found"}</div>
                <div className="mt-1 text-muted">{r.briefing.negotiation.decision}</div>
              </div>
            )}
          </div>
        </Card>
      ))}
      {reqs.data && !reqs.data.rows.length && <Empty>No requests yet.</Empty>}
    </div>
  );
}
