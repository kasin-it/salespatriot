import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, ExtLink, Field, Table, Unknown, fmtDate, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Companies() {
  const [q, setQ] = useState("");
  const [state, setState] = useState("");
  const [category, setCategory] = useState("");
  const filters = useApi<Row>("/procurement-filters");
  const { data, error } = useApi<Row>(`/companies?limit=100${q ? `&q=${encodeURIComponent(q)}` : ""}${state ? `&state=${state}` : ""}${category ? `&category=${category}` : ""}`, 15000);
  const nav = useNavigate();
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-bold">Company Intelligence</h1><p className="text-sm text-muted">Canonical company records. One company, many events; identity state is shown on every record.</p></div>
      <Card title="Filters"><div className="grid gap-3 md:grid-cols-3">
        <Field label="Name or website"><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
        <Field label="Identity state"><select value={state} onChange={(e) => setState(e.target.value)}><option value="">Any</option>{["UNVERIFIED", "IDENTIFIED", "VERIFIED", "NEEDS_REVIEW", "INACTIVE"].map((s) => <option key={s}>{s}</option>)}</select></Field>
        <Field label="Claimed capability"><select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">Any</option>{(filters.data?.categories ?? []).map((c: Row) => <option key={c.key} value={c.key}>{c.label}</option>)}</select></Field>
      </div></Card>
      <Err msg={error} />
      <Card title={`Companies (${data?.total ?? 0})`}>
        <Table rows={data?.rows ?? []} onRow={(r) => nav(`/companies/${r.id}`)} empty="No companies yet. They appear when an event is researched or a company registers." cols={[
          { h: "Company", r: (c) => <div><div className="font-medium">{c.canonical_name}</div><div className="text-[11px] text-muted">{c.website_domain ?? "website unknown"}</div></div> },
          { h: "Country", r: (c) => c.country ?? <Unknown /> }, { h: "Identity", r: (c) => <Badge value={c.identity_state} /> },
          { h: "Enrichment", r: (c) => <Badge value={c.enrichment_status} /> }, { h: "Events", r: (c) => c.events }, { h: "Capability claims", r: (c) => c.capabilities },
          { h: "Origin", r: (c) => <span className="text-[11px] text-muted">{c.is_registered ? "registered account" : c.origin}</span> },
        ]} />
      </Card>
    </div>
  );
}

export function CompanyDetail() {
  const { id } = useParams();
  const { data, error, reload } = useApi<Row>(`/companies/${id}`, 6000);
  const [msg, setMsg] = useState<string | null>(null);
  const [edit, setEdit] = useState({ field: "website", value: "", reason: "" });
  if (error) return <Err msg={error} />;
  if (!data) return <div className="text-muted">Loading…</div>;
  const c = data.company as Row;
  const act = async (path: string, body: unknown = {}) => { try { await api(path, { body }); setMsg("Queued / saved."); reload(); } catch (e) { setMsg((e as Error).message); } };
  const running = (data.tasks as Row[]).some((t) => ["QUEUED", "RUNNING", "RETRY_SCHEDULED"].includes(t.status));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><Link to="/companies" className="text-xs text-muted">← Companies</Link>
          <h1 className="text-xl font-bold">{c.canonical_name} <Badge value={c.identity_state} /></h1>
          <div className="text-sm text-muted">{c.legal_name && c.legal_name !== c.canonical_name ? `Legal name: ${c.legal_name} · ` : ""}{c.country ?? "Country unknown"} · <ExtLink href={c.website} /></div></div>
        <div className="flex gap-2"><Btn onClick={() => void act(`/companies/${id}/verify`)} disabled={running}>Verify identity (GLEIF/VIES)</Btn><Btn onClick={() => void act(`/companies/${id}/enrich`)} disabled={running}>Enrich from website</Btn></div>
      </div>
      {msg && <div className="text-xs text-muted">{msg}</div>}
      {(data.tasks as Row[]).length > 0 && <div className="flex flex-wrap gap-3 text-xs">{(data.tasks as Row[]).slice(0, 4).map((t) => <span key={t.id}>{t.type} <Badge value={t.status} />{t.error ? <span className="text-red-300"> {String(t.error).slice(0, 60)}</span> : null}</span>)}</div>}
      {(data.conflicts as Row[]).length > 0 && <Card title="Data conflicts (multiple sources disagree — all preserved)"><ul className="text-[13px]">{(data.conflicts as Row[]).map((k) => <li key={k.field}><b>{k.field}</b>: {(k.values as string[]).join("  ≠  ")}</li>)}</ul></Card>}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Identifiers"><Table rows={data.identifiers} empty="No identifiers known. Identity is based on name/website only." cols={[{ h: "Scheme", r: (i) => i.scheme }, { h: "Value", r: (i) => i.value }, { h: "Status", r: (i) => <Badge value={i.verified ? "VERIFIED" : "UNVERIFIED"} /> }, { h: "Source", r: (i) => <ExtLink href={i.source_url}>source</ExtLink> }]} />
          {(data.aliases as Row[]).length > 0 && <div className="mt-2 text-[12px] text-muted">Known aliases: {(data.aliases as Row[]).map((a) => a.alias).join("; ")}</div>}</Card>
        <Card title="Events attended"><Table rows={data.events} empty="Not linked to any event." cols={[{ h: "Event", r: (e) => <Link className="text-sky-300" to={`/events/${e.id}`}>{e.name}</Link> }, { h: "Dates", r: (e) => fmtDate(e.start_date) ?? <Unknown /> }, { h: "Stand", r: (e) => e.booth ?? <Unknown /> }, { h: "Evidence", r: (e) => <ExtLink href={e.profile_url ?? e.source_url}>profile</ExtLink> }]} /></Card>
      </div>
      <Card title="Capabilities (classification shown; evidence quoted from the source)">
        <Table rows={data.capabilities} empty="No capability evidence found. Unknown — requires company confirmation." cols={[
          { h: "Category", r: (k) => k.label }, { h: "Class", r: (k) => <Badge value={k.capability_class} /> },
          { h: "Evidence", r: (k) => <div className="max-w-xl text-[12px] italic text-muted">“{k.evidence_text}”<div className="not-italic"><ExtLink href={k.source_url?.startsWith("http") ? k.source_url : null}>{k.source_type}</ExtLink> · collected {fmtDate(k.collected_at)}</div></div> },
          { h: "", r: (k) => data.isMember && k.capability_class !== "VERIFIED_CAPABILITY" ? <div className="flex gap-1"><Btn onClick={() => void act(`/companies/${id}/confirm-capability`, { capabilityId: k.id, confirm: true })}>Confirm</Btn><Btn tone="danger" onClick={() => void act(`/companies/${id}/confirm-capability`, { capabilityId: k.id, confirm: false })}>Reject</Btn></div> : null },
        ]} />
        <p className="mt-2 text-[11px] text-muted">Production capacity, stock, pricing, lead times and military qualifications are never inferred; they stay unknown until the company supplies them.</p>
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Products (headings on official product pages)"><Table rows={data.products} empty="No product pages found. Unknown." cols={[{ h: "Name", r: (p) => p.name }, { h: "Source", r: (p) => <ExtLink href={p.source_url}>page</ExtLink> }, { h: "Status", r: (p) => <Badge value={p.verification_status} /> }]} /></Card>
        <Card title="Certifications (mentions on the company's own site — not checked against certificates)"><Table rows={data.certifications} empty="None found. Unknown." cols={[{ h: "Certification", r: (p) => p.name }, { h: "Evidence", r: (p) => <span className="text-[12px] italic text-muted">“{p.evidence_text}”</span> }]} /></Card>
        <Card title="Public contacts (published by the company)"><Table rows={data.contacts} empty="No public contacts found." cols={[{ h: "Kind", r: (p) => p.kind }, { h: "Value", r: (p) => p.value }, { h: "Source", r: (p) => <ExtLink href={p.source_url}>page</ExtLink> }]} /></Card>
        <Card title="Public procurement awards naming this company"><Table rows={data.procurementAwards} empty="None found in stored notices." cols={[{ h: "Notice", r: (n) => <ExtLink href={n.source_url}>{n.title ?? n.source_url}</ExtLink> }, { h: "Authority", r: (n) => n.contracting_authority }, { h: "Date", r: (n) => fmtDate(n.publication_date) }]} /></Card>
      </div>
      <Card title="Source evidence (all facts, newest first)">
        <Table rows={(data.facts as Row[]).slice(0, 80)} empty="No facts recorded." cols={[
          { h: "Field", r: (f) => f.field_name }, { h: "Value", r: (f) => <span className={f.superseded_by ? "line-through opacity-60" : ""}>{f.field_value}</span> },
          { h: "Kind", r: (f) => <Badge value={f.fact_kind} tone="grey" /> }, { h: "Status", r: (f) => <Badge value={f.verification_status} /> },
          { h: "Source", r: (f) => <ExtLink href={f.source_url}>{f.source_type}</ExtLink> }, { h: "Collected", r: (f) => fmtTime(f.collected_at) }, { h: "Conf.", r: (f) => f.confidence },
        ]} />
      </Card>
      {data.isMember ? (
        <Card title="Correct company information (authorised representatives)">
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Field"><select value={edit.field} onChange={(e) => setEdit({ ...edit, field: e.target.value })}>{["website", "legal_name", "description", "country"].map((f) => <option key={f}>{f}</option>)}</select></Field>
            <Field label="New value"><input value={edit.value} onChange={(e) => setEdit({ ...edit, value: e.target.value })} /></Field>
            <Field label="Reason"><input value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></Field>
            <div className="flex items-end"><Btn tone="primary" onClick={() => void act(`/companies/${id}/facts`, edit)} disabled={!edit.value || edit.reason.length < 3}>Save (previous evidence is kept)</Btn></div>
          </div>
        </Card>
      ) : <Empty>Only an authorised representative of this company can correct or confirm its information.</Empty>}
    </div>
  );
}
