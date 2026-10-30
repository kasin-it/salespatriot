import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Notice, PageHead, Table, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

const TERM_FIELDS: [string, string, "number" | "text"][] = [["unitPrice", "Unit price", "number"], ["currency", "Currency (3 letters)", "text"], ["quantity", "Quantity", "number"], ["moq", "MOQ", "number"], ["deliveryTerms", "Delivery terms", "text"], ["deliveryLocation", "Delivery location", "text"], ["leadTimeDays", "Lead time (days)", "number"], ["paymentTerms", "Payment terms", "text"], ["warranty", "Warranty", "text"], ["validUntil", "Valid until (ISO date-time)", "text"], ["technicalSpecs", "Technical specs", "text"]];

export function Negotiations() {
  const list = useApi<Row[]>("/negotiations", 8000);
  const me = useApi<Row>("/me");
  const companies = useApi<Row>("/companies?limit=500");
  const nav = useNavigate();
  const [f, setF] = useState({ buyerId: "", supplierId: "", subject: "", mode: "SANDBOX" });
  const [err, setErr] = useState<string | null>(null);
  const create = async () => { try { const r = await api<Row>("/negotiations", { body: { ...f, buyerId: Number(f.buyerId), supplierId: Number(f.supplierId) } }); void nav(`/negotiations/${r.id}`); } catch (e) { setErr((e as Error).message); } };
  const mine = (me.data?.companies ?? []) as Row[];
  return (
    <div className="space-y-5">
      <PageHead title="Negotiation Room" sub="Structured, versioned offers. REAL negotiations require both companies to hold authorised accounts. SANDBOX uses public company records and never counts as business." />
      {mine.length === 0 && <Empty>Register your company in Settings first. Only authorised companies can negotiate.</Empty>}
      <Card title="Start a negotiation">
        <div className="grid gap-3 md:grid-cols-5">
          <Field label="Buyer"><select value={f.buyerId} onChange={(e) => setF({ ...f, buyerId: e.target.value })}><option value="">Select…</option>{(companies.data?.rows ?? []).map((c: Row) => <option key={c.id} value={c.id}>{c.canonical_name}{mine.some((m) => m.id === c.id) ? " (yours)" : ""}</option>)}</select></Field>
          <Field label="Supplier"><select value={f.supplierId} onChange={(e) => setF({ ...f, supplierId: e.target.value })}><option value="">Select…</option>{(companies.data?.rows ?? []).map((c: Row) => <option key={c.id} value={c.id}>{c.canonical_name}{mine.some((m) => m.id === c.id) ? " (yours)" : ""}</option>)}</select></Field>
          <Field label="Subject"><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
          <Field label="Mode"><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="SANDBOX">SANDBOX (simulation)</option><option value="REAL">REAL</option></select></Field>
          <div className="flex items-end"><Btn tone="primary" onClick={() => void create()} disabled={!f.buyerId || !f.supplierId || f.subject.length < 3}>Create</Btn></div>
        </div>
        <Err msg={err} />
      </Card>
      <Card title="Negotiations">
        <Table rows={list.data ?? []} onRow={(n) => nav(`/negotiations/${n.id}`)} empty="No negotiations yet." cols={[
          { h: "#", r: (n) => n.id }, { h: "Subject", r: (n) => n.subject }, { h: "Buyer → Supplier", r: (n) => `${n.buyer_name} → ${n.supplier_name}` }, { h: "Mode", r: (n) => <Badge value={n.mode} /> }, { h: "State", r: (n) => <Badge value={n.state} /> }, { h: "Round", r: (n) => n.round }, { h: "Updated", r: (n) => fmtTime(n.updated_at) },
        ]} />
      </Card>
    </div>
  );
}

export function NegotiationRoom() {
  const { id } = useParams();
  const { data, error, reload } = useApi<Row>(`/negotiations/${id}`, 5000);
  const me = useApi<Row>("/me");
  const [terms, setTerms] = useState<Record<string, string>>({});
  const [kind, setKind] = useState("rfq");
  const [recorded, setRecorded] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (error) return <Err msg={error} />;
  if (!data) return <div className="text-muted">Loading…</div>;
  const n = data.negotiation as Row;
  const mine = ((me.data?.companies ?? []) as Row[]).filter((c) => c.id === n.buyer_company_id || c.id === n.supplier_company_id);
  const company = mine[0];
  const side = company?.id === n.buyer_company_id ? "BUYER" : "SUPPLIER";
  const offers = data.offers as Row[];
  const current = offers.find((o) => o.id === n.current_offer_id);
  const done = ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"].includes(n.state);
  const toTerms = () => Object.fromEntries(TERM_FIELDS.map(([k, , t]) => [k, terms[k] === undefined || terms[k] === "" ? null : t === "number" ? Number(terms[k]) : terms[k]]));
  const call = async (path: string, body: Row) => {
    try { const r = await api<Row>(path, { body }); setMsg(r.dealRef ? `Deal recorded: ${r.dealRef}` : r.pending?.length ? `Recorded. Waiting for: ${r.pending.join(", ")}` : "Done"); reload(); }
    catch (e) { setMsg(e instanceof ApiError && (e.data as Row)?.reasons ? `Approval required: ${(e.data as Row).reasons.join("; ")}${(e.data as Row).approvalId ? ` (approval #${(e.data as Row).approvalId} created)` : ""}` : (e as Error).message); reload(); }
  };
  const autopilot = async () => {
    try {
      const r = await api<Row>(`/negotiations/${id}/autopilot`, { body: { rfqTerms: { quantity: terms.quantity ? Number(terms.quantity) : null, deliveryLocation: terms.deliveryLocation || null } } });
      setMsg(`${r.outcome}${r.dealRef ? ` — ${r.dealRef}` : ""} · human approvals: ${r.humanApprovals} · ${r.log.join(" → ")}${r.reason ? ` · ${r.reason}` : ""}`); reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="space-y-5">
      <div className="space-y-2"><Link to="/negotiations" className="text-xs text-accent underline-offset-2 hover:underline hover:text-accent">← Negotiations</Link>
        <PageHead title={<>{n.subject} <Badge value={n.state} /> <Badge value={n.mode} /></>} sub={<>Round {n.round} · {data.deal ? `Deal ${data.deal.deal_ref}` : "no deal yet"}</>} />
        {n.mode === "SANDBOX" && <Notice tone="warn">SANDBOX: a simulated workflow on public company records. Offers, acceptance and any resulting deal are NOT real commercial events and are excluded from business reporting.</Notice>}</div>
      {msg && <div className="border border-edge bg-paper p-2 text-sm">{msg}</div>}
      <Card title="Offer history (versioned; each counter references the previous version)">
        <Table rows={offers} empty="No offers yet. The buyer starts with an RFQ." cols={[
          { h: "v", r: (o) => o.version }, { h: "Kind", r: (o) => o.kind }, { h: "From", r: (o) => (o.from_company_id === n.buyer_company_id ? "Buyer" : "Supplier") }, { h: "Refs", r: (o) => (o.previous_offer_id ? `v${offers.find((x) => x.id === o.previous_offer_id)?.version}` : "—") },
          { h: "Terms", r: (o) => <span className="text-[12px]">{Object.entries(o.terms as Row).filter(([, v]) => v != null).map(([k, v]) => `${k}: ${v}`).join(" · ") || "—"}</span> },
          { h: "Origin", r: (o) => <span className="text-[11px]">{o.origin} / {o.created_by}</span> }, { h: "Status", r: (o) => <Badge value={o.status} /> }, { h: "At", r: (o) => fmtTime(o.created_at) },
          { h: "", r: (o) => !done && o.id === n.current_offer_id && company && o.from_company_id !== company.id ? <Btn tone="primary" onClick={() => void call(`/negotiations/${id}/accept`, { companyId: company.id, offerId: o.id })}>Accept v{o.version}</Btn> : null },
        ]} />
        {current && <div className="mt-2 text-xs text-muted">Acceptances on v{current.version}: {(data.acceptances as Row[]).filter((a) => a.offer_id === current.id).map((a) => `company ${a.company_id} (${a.authorization_basis})`).join("; ") || "none"}</div>}
      </Card>
      {!done && company ? (
        <Card title={`Submit offer as ${company.name} (${side})`} actions={<div className="flex gap-2"><Btn onClick={() => void call(`/negotiations/${id}/agent-step`, { companyId: company.id })}>Let my agent respond</Btn><Btn tone="primary" onClick={() => void autopilot()}>AUTOPILOT: negotiate &amp; close (no human)</Btn></div>}>
          <div className="mb-3 flex flex-wrap gap-3 text-xs">
            <select className="!w-48" value={kind} onChange={(e) => setKind(e.target.value)}>{side === "BUYER" ? <option value="rfq">RFQ</option> : <option value="quotation">Quotation</option>}<option value="counter">Counteroffer</option></select>
            <label className="mb-0 flex items-center gap-2 font-sans normal-case text-ink"><input className="!w-auto" type="checkbox" checked={recorded} onChange={(e) => setRecorded(e.target.checked)} />Record an offer the counterparty actually sent me</label>
          </div>
          <div className="grid gap-3 md:grid-cols-4">{TERM_FIELDS.map(([k, label]) => <Field key={k} label={label}><input value={terms[k] ?? ""} onChange={(e) => setTerms({ ...terms, [k]: e.target.value })} /></Field>)}</div>
          <div className="mt-3 flex gap-2">
            <Btn tone="primary" onClick={() => void call(`/negotiations/${id}/${kind === "rfq" && side === "BUYER" ? "rfq" : kind}`, { companyId: company.id, terms: toTerms(), externalRecorded: recorded })}>Submit</Btn>
            <Btn tone="danger" onClick={() => void call(`/negotiations/${id}/reject`, { reason: "Rejected by user" })}>Reject</Btn><Btn onClick={() => void call(`/negotiations/${id}/cancel`, {})}>Cancel</Btn>
          </div>
          <p className="mt-2 text-[11px] text-muted">Backend limits are enforced on every offer. Missing limits or exceeding them creates an approval request instead of sending. No term is ever defaulted.</p>
        </Card>
      ) : !company ? <Empty>You are not a party to this negotiation with any of your companies.</Empty> : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="State transitions"><Table rows={data.transitions} cols={[{ h: "From", r: (t) => t.from_state ?? "—" }, { h: "To", r: (t) => <Badge value={t.to_state} /> }, { h: "Actor", r: (t) => t.actor }, { h: "Reason", r: (t) => t.reason }, { h: "At", r: (t) => fmtTime(t.created_at) }]} /></Card>
        <Card title="Approvals"><Table rows={data.approvals} empty="None." cols={[{ h: "#", r: (a) => a.id }, { h: "Reason", r: (a) => a.reason }, { h: "Status", r: (a) => <Badge value={a.status} /> }]} /></Card>
      </div>
    </div>
  );
}
