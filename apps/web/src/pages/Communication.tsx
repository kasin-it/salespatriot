import { useState } from "react";
import { api, useApi } from "../api.ts";
import { Badge, Btn, Card, Empty, Err, Field, Table, fmtTime } from "../ui.tsx";
import type { Row } from "../types.ts";

export function Communication() {
  const me = useApi<Row>("/me");
  const [cid, setCid] = useState<number | null>(null);
  const companyId = cid ?? me.data?.companies?.[0]?.id ?? null;
  const emails = useApi<Row>(companyId ? `/emails?companyId=${companyId}` : null, 8000);
  const calls = useApi<Row>(companyId ? `/calls?companyId=${companyId}` : null, 8000);
  const [targetCompany, setTargetCompany] = useState("");
  const contacts = useApi<Row[]>(targetCompany ? `/contacts?companyId=${targetCompany}` : null);
  const companies = useApi<Row>("/companies?limit=200");
  const [draft, setDraft] = useState({ contactId: "", subject: "", body: "" });
  const [incoming, setIncoming] = useState({ fromAddress: "", subject: "", body: "" });
  const [parsed, setParsed] = useState<Row | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => { try { const r = await fn(); setMsg(typeof r === "object" && r && "note" in r ? String((r as Row).note) : ok); emails.reload(); calls.reload(); return r; } catch (e) { setMsg((e as Error).message); } };
  if (me.data && !me.data.companies.length) return <Empty>Register a company in Settings to use the Communication Hub.</Empty>;
  return (
    <div className="space-y-5">
      <div><h1 className="text-xl font-bold">Communication Hub</h1><p className="text-sm text-muted">Drafts only by default. Recipients must be public contacts already stored for a company. Sending needs a configured provider and your explicit action.</p></div>
      <Err msg={msg} />
      <Card title="Sending company">
        <select className="!w-72" value={companyId ?? ""} onChange={(e) => setCid(Number(e.target.value))}>{(me.data?.companies ?? []).map((c: Row) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <div className="mt-2 text-xs text-muted">Email provider: {emails.data?.smtpConfigured ? <Badge value="CONNECTED" /> : <Badge value="NOT_CONFIGURED" />} · Voice provider: {calls.data?.providerConfigured ? <Badge value="CONNECTED" /> : <Badge value="NOT_CONFIGURED" />}</div>
      </Card>
      <Card title="Draft an email">
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Recipient company"><select value={targetCompany} onChange={(e) => setTargetCompany(e.target.value)}><option value="">Select…</option>{(companies.data?.rows ?? []).map((c: Row) => <option key={c.id} value={c.id}>{c.canonical_name}</option>)}</select></Field>
          <Field label="Public email contact"><select value={draft.contactId} onChange={(e) => setDraft({ ...draft, contactId: e.target.value })}><option value="">{targetCompany && !(contacts.data ?? []).some((c) => c.kind === "email") ? "No public email stored for this company" : "Select…"}</option>{(contacts.data ?? []).filter((c) => c.kind === "email").map((c) => <option key={c.id} value={c.id}>{c.value}</option>)}</select></Field>
          <Field label="Subject"><input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} /></Field>
          <div className="md:col-span-2"><Field label="Body"><textarea rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} /></Field></div>
        </div>
        <div className="mt-3"><Btn tone="primary" disabled={!draft.contactId || !draft.subject || draft.body.length < 10} onClick={() => void run(() => api("/emails/draft", { body: { companyId, contactId: Number(draft.contactId), subject: draft.subject, body: draft.body } }), "Draft saved")}>Save draft</Btn></div>
      </Card>
      <Card title="Messages">
        <Table rows={emails.data?.rows ?? []} empty="No messages recorded." cols={[
          { h: "Dir", r: (m) => m.direction }, { h: "To / from", r: (m) => m.to_address ?? m.from_address }, { h: "Subject", r: (m) => m.subject }, { h: "Status", r: (m) => <Badge value={m.status} /> }, { h: "Mode", r: (m) => m.mode }, { h: "Created", r: (m) => fmtTime(m.created_at) },
          { h: "", r: (m) => m.status === "DRAFT" ? <Btn onClick={() => void run(() => api(`/emails/${m.id}/send`, { body: {} }), "Done").then((r) => r && setMsg((r as Row).sent ? "Email sent" : String((r as Row).reason)))}>Send (explicit approval)</Btn> : <span className="text-[11px] text-red-300">{m.error}</span> },
        ]} />
      </Card>
      <Card title="Record an incoming reply (parse offer terms)">
        <div className="grid gap-3 md:grid-cols-2"><Field label="From"><input value={incoming.fromAddress} onChange={(e) => setIncoming({ ...incoming, fromAddress: e.target.value })} /></Field><Field label="Subject"><input value={incoming.subject} onChange={(e) => setIncoming({ ...incoming, subject: e.target.value })} /></Field>
          <div className="md:col-span-2"><Field label="Body (paste the real reply)"><textarea rows={4} value={incoming.body} onChange={(e) => setIncoming({ ...incoming, body: e.target.value })} /></Field></div></div>
        <div className="mt-3 flex gap-2"><Btn onClick={() => void api<Row>("/emails/parse-terms", { body: { text: incoming.body } }).then(setParsed)}>Preview parsed terms</Btn><Btn tone="primary" onClick={() => void run(() => api("/emails/incoming", { body: { companyId, ...incoming } }), "Recorded")} disabled={!incoming.fromAddress.includes("@") || incoming.body.length < 3}>Record reply</Btn></div>
        {parsed && <pre className="mt-3 rounded bg-black/40 p-2 text-xs">{Object.keys(parsed).length ? JSON.stringify(parsed, null, 1) : "No labelled terms found in the text. Nothing is guessed."}</pre>}
      </Card>
      <Card title="Voice call scripts"><Table rows={calls.data?.rows ?? []} empty="No call scripts prepared. No calls are placed unless a voice provider is configured and approved." cols={[{ h: "To", r: (c) => c.to_number }, { h: "Purpose", r: (c) => c.purpose }, { h: "Status", r: (c) => <Badge value={c.status} /> }, { h: "AI disclosure", r: (c) => <span className="text-[11px] text-muted">{c.ai_disclosure}</span> }]} /></Card>
    </div>
  );
}
