import { useState } from "react";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Table } from "../ui.tsx";
import type { Row } from "../types.ts";

const POLICY_FIELDS: [string, string][] = [["currency", "Currency"], ["max_unit_price", "Max purchase price (buyer)"], ["min_unit_price", "Min sale price (supplier)"], ["max_quantity", "Max quantity"], ["min_quantity", "Min quantity"], ["allowed_payment_terms", "Allowed payment terms (comma list)"], ["max_lead_time_days", "Max lead time (days)"], ["max_rounds", "Max negotiation rounds"], ["approval_required_above_total", "Human approval above total"], ["opening_unit_price", "Opening unit price (first bid / first quote)"], ["opening_lead_time_days", "Opening lead time (days, supplier)"], ["opening_payment_terms", "Opening payment terms"], ["opening_delivery_terms", "Opening delivery terms (supplier)"], ["opening_validity_days", "Quote validity (days, supplier)"]];

export function Settings() {
  const me = useApi<Row>("/me");
  const [f, setF] = useState<Record<string, string>>({ authorizationLevel: "STANDARD" });
  const [msg, setMsg] = useState<string | null>(null);
  const [token, setTokenVal] = useState<string | null>(null);
  const register = async () => {
    try {
      const r = await api<Row>("/companies", { body: { legalName: f.legalName, website: f.website || undefined, country: f.country || undefined, registrationNumber: f.registrationNumber || undefined, vat: f.vat || undefined, lei: f.lei || undefined, businessEmailDomain: f.businessEmailDomain || undefined, jobTitle: f.jobTitle || undefined, authorizationLevel: f.authorizationLevel } });
      setMsg(`Company registered (#${r.companyId}). Identity research queued — follow it on the company page.`); me.reload();
    } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-bold">Settings</h1></div>
      <Err msg={msg} />
      <Card title="Register your company">
        <p className="mb-3 text-xs text-muted">Only the identity details you have are needed. Everything you enter is stored as USER_PROVIDED and verified against GLEIF/VIES where possible; unverified identifiers are labelled as such.</p>
        <div className="grid gap-3 md:grid-cols-4">
          {([["legalName", "Legal company name *"], ["website", "Official website"], ["country", "Country (ISO-2, e.g. PL)"], ["registrationNumber", "Registration number"], ["vat", "VAT number"], ["lei", "LEI"], ["businessEmailDomain", "Business email domain"], ["jobTitle", "Your role in the company"]] as [string, string][]).map(([k, l]) => <Field key={k} label={l}><input value={f[k] ?? ""} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></Field>)}
          <Field label="Your authorisation level"><select value={f.authorizationLevel} onChange={(e) => setF({ ...f, authorizationLevel: e.target.value })}><option value="SIGNATORY">SIGNATORY (can accept offers)</option><option value="STANDARD">STANDARD</option><option value="READ_ONLY">READ_ONLY</option></select></Field>
        </div>
        <div className="mt-3"><Btn tone="primary" disabled={!f.legalName} onClick={() => void register()}>Register &amp; start research</Btn></div>
      </Card>
      <Card title="Your companies">
        {(me.data?.companies ?? []).length ? <Table rows={me.data!.companies} cols={[{ h: "Company", r: (c: Row) => <a className="text-sky-300" href={`/companies/${c.id}`}>{c.name}</a> }, { h: "Identity", r: (c: Row) => <Badge value={c.identity_state} /> }, { h: "Role", r: (c: Row) => c.role }, { h: "Authorisation", r: (c: Row) => c.authorization_level }]} /> : <Empty>No company registered.</Empty>}
      </Card>
      {(me.data?.companies ?? []).filter((c: Row) => c.role === "ADMIN").map((c: Row) => <PolicyEditor key={c.id} company={c} />)}
      <Card title="API token (for the Arsenal MCP server / Claude Desktop)">
        <Btn onClick={() => void api<Row>("/tokens", { body: { label: "Claude Desktop MCP", scopes: ["read", "write"] } }).then((r) => setTokenVal(r.token))}>Create token</Btn>
        {token && <div className="mt-2 break-all rounded bg-black/40 p-2 text-xs">{token}<div className="mt-1 text-muted">Shown once. Set it as ARSENAL_API_TOKEN for the MCP server.</div></div>}
      </Card>
    </div>
  );
}

function PolicyEditor({ company }: { company: Row }) {
  const pol = useApi<Row[]>(`/companies/${company.id}/policy`);
  const [side, setSide] = useState<"BUYER" | "SUPPLIER">("BUYER");
  const [v, setV] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const cur = (pol.data ?? []).find((p) => p.side === side);
  const save = async () => {
    const body: Row = {};
    for (const [k] of POLICY_FIELDS) if (v[k] !== undefined && v[k] !== "") body[k] = ["currency", "allowed_payment_terms", "opening_payment_terms", "opening_delivery_terms"].includes(k) ? v[k] : Number(v[k]);
    if (v.autonomous_accept !== undefined) body.autonomous_accept = Number(v.autonomous_accept);
    try { await api(`/companies/${company.id}/policy/${side}`, { method: "PUT", body }); setMsg("Saved"); pol.reload(); setV({}); } catch (e) { setMsg((e as Error).message); }
  };
  return (
    <Card title={`Negotiation limits — ${company.name}`} actions={<select className="!w-32" value={side} onChange={(e) => setSide(e.target.value as "BUYER" | "SUPPLIER")}><option>BUYER</option><option>SUPPLIER</option></select>}>
      <p className="mb-3 text-xs text-muted">These limits are enforced by the backend on every offer and acceptance; agents cannot exceed them. Nothing is pre-filled: unset limits mean human approval is required.</p>
      <div className="grid gap-3 md:grid-cols-4">
        {POLICY_FIELDS.map(([k, l]) => <Field key={k} label={`${l}${cur?.[k] != null ? ` — now: ${cur[k]}` : " — not set"}`}><input value={v[k] ?? ""} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></Field>)}
        <Field label={`Agent may accept autonomously — now: ${cur?.autonomous_accept ? "YES" : "no"}`}><select value={v.autonomous_accept ?? ""} onChange={(e) => setV({ ...v, autonomous_accept: e.target.value })}><option value="">(unchanged)</option><option value="0">No — always ask a human</option><option value="1">Yes, within limits</option></select></Field>
      </div>
      <div className="mt-3 flex items-center gap-3"><Btn tone="primary" onClick={() => void save()}>Save limits</Btn>{msg && <span className="text-xs text-muted">{msg}</span>}</div>
    </Card>
  );
}
