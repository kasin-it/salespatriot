import nodemailer from "nodemailer";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { cleanText, errorMessage, excerpt, now, randomToken } from "../lib/util.ts";
import { CATEGORY_BY_KEY, CERTIFICATION_PATTERNS, classifyText } from "../lib/taxonomy.ts";
import { parseTermsFromText } from "./communication.ts";
import { dbPath } from "../db/db.ts";
import { extractFromImage, visionConfigured, visionToText, type VisionResult } from "./vision.ts";
import { demandForCategory } from "./demand.ts";
import { logAgentEmail } from "./emaillog.ts";

/**
 * Field requests: the agent writes to a person who is physically at the event and asks for a photo of the stand/product,
 * the specification and the product presentation. Replies are read from the mailbox, attachments are stored, and structured
 * values are extracted ONLY when they literally appear in the supplied material. Anything not present is reported as a gap.
 */

export const mailpitUrl = (): string | null => process.env.MAILPIT_URL ?? null;
const smtpReady = (): boolean => !!(process.env.SMTP_HOST && process.env.SMTP_FROM);

export function addFieldRep(companyId: number, name: string, email: string, userId: number): number {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error("Invalid email");
  const db = getDb();
  db.run("INSERT OR IGNORE INTO field_reps (company_id, name, email, created_by_user_id) VALUES (?,?,?,?)", companyId, name, email, userId);
  return db.get<{ id: number }>("SELECT id FROM field_reps WHERE company_id=? AND email=?", companyId, email)!.id;
}

export function requestBody(a: { repName: string; eventName: string; standHint: string | null; targetName: string | null; token: string; extraLines?: string[] }): { subject: string; body: string } {
  const where = a.standHint ? ` (${a.standHint})` : "";
  const who = a.targetName ? ` firmy ${a.targetName}` : "";
  return {
    subject: `Jesteś na evencie? Sprawdź stoisko${where} [${a.token}]`,
    body: [
      `Cześć ${a.repName},`,
      "",
      `jesteś teraz na evencie ${a.eventName}? Podejdź proszę do stoiska${who}${where} i odpisz na tego maila z:`,
      "1. zdjęciem ulotki / produktu / stoiska,",
      "2. specyfikacją produktu (PDF, zdjęcie lub tekst),",
      "3. prezentacją produktu lub folderem, jeśli jest.",
      "",
      "Nic więcej nie musisz robić — resztą (dopasowanie do przetargu i rozmowy z agentem dostawcy) zajmuje się agent.",
      ...(a.extraLines?.length ? ["", ...a.extraLines] : []),
      "",
      `Nie zmieniaj tematu wiadomości (kod ${a.token}).`,
      "— Agent Arsenal AI",
    ].join("\n"),
  };
}

export async function sendFieldRequest(i: { companyId: number; repId: number; eventId?: number; targetCompanyId?: number; standHint?: string; userId: number | null; rfqTerms?: Record<string, unknown>; autoNegotiate?: boolean; extraLines?: string[]; missionId?: number }): Promise<number> {
  const db = getDb();
  const rep = db.get<{ name: string; email: string; company_id: number }>("SELECT * FROM field_reps WHERE id=?", i.repId);
  if (!rep || rep.company_id !== i.companyId) throw new Error("Field rep not found for this company");
  const ev = i.eventId ? db.get<{ name: string }>("SELECT name FROM events WHERE id=?", i.eventId) : undefined;
  const target = i.targetCompanyId ? db.get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", i.targetCompanyId) : undefined;
  const token = `ARS-${randomToken(3).toUpperCase()}`;
  const m = requestBody({ repName: rep.name, eventName: ev?.name ?? "evencie", standHint: i.standHint ?? null, targetName: target?.canonical_name ?? null, token, extraLines: i.extraLines });
  const id = db.insert("field_requests", { company_id: i.companyId, rep_id: i.repId, event_id: i.eventId ?? null, target_company_id: i.targetCompanyId ?? null, token, stand_hint: i.standHint ?? null, subject: m.subject, body: m.body, mode: smtpReady() ? "SMTP" : "DRAFT_ONLY", status: "DRAFT", rfq_terms: i.rfqTerms ? JSON.stringify(i.rfqTerms) : null, auto_negotiate: i.autoNegotiate ? 1 : 0, mission_id: i.missionId ?? null });
  if (!smtpReady()) {
    db.update("field_requests", id, { status: "NOT_SENT_NO_PROVIDER", error: "SMTP_HOST / SMTP_FROM not configured; nothing was sent" });
    audit({ actorType: "agent", actorId: "email", companyId: i.companyId, action: "field_request.not_sent", entityType: "field_request", entityId: id, summary: "Field request drafted; no SMTP provider configured" });
    return id;
  }
  try {
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true", auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
    await t.sendMail({ from: process.env.SMTP_FROM, to: rep.email, subject: m.subject, text: m.body });
    logAgentEmail({ kind: "field_request", from: process.env.SMTP_FROM!, to: rep.email, subject: m.subject, body: m.body, missionId: i.missionId ?? null });
    db.update("field_requests", id, { status: "REQUESTED", sent_at: now() });
    audit({ actorType: "agent", actorId: "email", companyId: i.companyId, action: "field_request.sent", entityType: "field_request", entityId: id, summary: `Asked ${rep.name} (${rep.email}) for photo, specification and presentation` });
  } catch (e) {
    db.update("field_requests", id, { status: "FAILED", error: errorMessage(e) });
    throw e;
  }
  return id;
}

interface MpMessage { ID: string; Subject: string; From: { Address: string }; Attachments: number }
interface MpDetail { ID: string; Subject: string; From: { Address: string }; Text: string; Attachments: { PartID: string; FileName: string; ContentType: string; Size: number }[] }

const kindOf = (name: string, ct: string): "IMAGE" | "PDF" | "TEXT" | "OTHER" =>
  ct.startsWith("image/") || /\.(png|jpe?g|webp|heic)$/i.test(name) ? "IMAGE" : /pdf/.test(ct) || /\.pdf$/i.test(name) ? "PDF" : ct.startsWith("text/") || /\.(txt|md|csv)$/i.test(name) ? "TEXT" : "OTHER";

let visionTransportOverride: Parameters<typeof extractFromImage>[2] | undefined;
/** Tests inject a fixture transport; production uses fetch. */
export const setVisionTransport = (t: typeof visionTransportOverride): void => { visionTransportOverride = t; };
const visionTransport = () => visionTransportOverride;

export interface SpecExtraction {
  vision?: VisionResult;
  terms: Record<string, unknown>;
  categories: { key: string; label: string; passage: string }[];
  certifications: { name: string; passage: string }[];
  gaps: string[];
}

/** Deterministic extraction. Every value comes from the supplied text; absent values become explicit gaps. */
export function extractSpec(text: string): SpecExtraction {
  const clean = cleanText(text) ?? "";
  const terms = parseTermsFromText(text);
  const categories = classifyText(clean).map((h) => ({ key: h.key, label: CATEGORY_BY_KEY.get(h.key)?.label ?? h.key, passage: excerpt(clean, h.index, 100) }));
  const certifications = CERTIFICATION_PATTERNS.flatMap((c) => { const m = c.re.exec(clean); return m ? [{ name: c.name, passage: excerpt(clean, m.index, 80) }] : []; });
  const gaps: string[] = [];
  if (terms.unitPrice == null) gaps.push("Price not stated");
  if (terms.leadTimeDays == null) gaps.push("Lead time not stated");
  if (terms.quantity == null && terms.moq == null) gaps.push("Quantity / MOQ not stated");
  if (!certifications.length) gaps.push("No certifications mentioned");
  if (terms.paymentTerms == null) gaps.push("Payment terms not stated");
  if (terms.deliveryTerms == null) gaps.push("Delivery terms not stated");
  return { terms, categories, certifications, gaps };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const doc = await getDocumentProxy(bytes);
  const r = await extractText(doc, { mergePages: true });
  return Array.isArray(r.text) ? r.text.join("\n") : r.text;
}

/** Read the mailbox (Mailpit REST API), match replies by token, store attachments, extract. Idempotent. */
export async function pollInbox(): Promise<{ checked: number; replies: number; repliedIds: number[] }> {
  const base = mailpitUrl();
  if (!base) throw new Error("MAILPIT_URL is not configured; inbox polling is off");
  const db = getDb();
  const list = (await (await fetch(`${base}/api/v1/messages?limit=100`)).json()) as { messages: MpMessage[] };
  const open = db.all<{ id: number; token: string; company_id: number; target_company_id: number | null; rep_email: string }>(
    "SELECT r.id, r.token, r.company_id, r.target_company_id, p.email rep_email FROM field_requests r JOIN field_reps p ON p.id=r.rep_id WHERE r.status IN ('REQUESTED','REPLIED')");
  let replies = 0;
  const repliedIds: number[] = [];
  for (const m of list.messages ?? []) {
    if (db.get("SELECT 1 FROM inbox_seen WHERE message_ref=?", m.ID)) continue;
    const req = open.find((r) => m.Subject.includes(r.token) && m.From.Address.toLowerCase() === r.rep_email.toLowerCase() && !m.Subject.startsWith("Jesteś na evencie"));
    db.run("INSERT OR IGNORE INTO inbox_seen (message_ref) VALUES (?)", m.ID);
    if (!req) continue;
    const d = (await (await fetch(`${base}/api/v1/message/${m.ID}`)).json()) as MpDetail;
    const dir = join(resolve(dirname(dbPath())), "attachments", req.token);
    mkdirSync(dir, { recursive: true });
    const texts: string[] = [d.Text ?? ""];
    for (const a of d.Attachments ?? []) {
      const safe = a.FileName.replace(/[^\w.\- ]/g, "_");
      const bytes = new Uint8Array(await (await fetch(`${base}/api/v1/message/${m.ID}/part/${a.PartID}`)).arrayBuffer());
      const path = join(dir, `${m.ID}-${safe}`);
      writeFileSync(path, bytes);
      const kind = kindOf(a.FileName, a.ContentType);
      let status = "STORED"; let extracted: SpecExtraction | null = null;
      try {
        if (kind === "PDF") { const t = await pdfText(bytes); texts.push(t); extracted = extractSpec(t); status = "EXTRACTED_TEXT"; }
        else if (kind === "TEXT") { const t = new TextDecoder().decode(bytes); texts.push(t); extracted = extractSpec(t); status = "EXTRACTED_TEXT"; }
        else if (kind === "IMAGE") {
          if (!visionConfigured()) status = "NEEDS_VISION_NOT_CONFIGURED"; // photo kept as evidence; nothing is read from it
          else {
            const v: VisionResult = await extractFromImage(bytes, a.ContentType || "image/jpeg", visionTransport());
            const t = visionToText(v); texts.push(t);
            extracted = { ...extractSpec(t), vision: v } as SpecExtraction;
            status = v.readable ? "EXTRACTED_VISION" : "VISION_UNREADABLE";
          }
        }
      } catch (e) { status = `EXTRACTION_FAILED: ${errorMessage(e).slice(0, 120)}`; }
      db.run("INSERT OR IGNORE INTO email_attachments (field_request_id, message_ref, filename, content_type, size, path, kind, extraction_status, extracted) VALUES (?,?,?,?,?,?,?,?,?)", req.id, m.ID, a.FileName, a.ContentType, a.Size, path, kind, status, extracted ? JSON.stringify(extracted) : null);
    }
    const summary = extractSpec(texts.join("\n"));
    db.update("field_requests", req.id, { status: "REPLIED", replied_at: now(), summary: JSON.stringify({ ...summary, attachments: (d.Attachments ?? []).length, photoCount: (d.Attachments ?? []).filter((a) => kindOf(a.FileName, a.ContentType) === "IMAGE").length }) });
    // Record the supplier material as company-published claims about the target company, quoted from the supplied documents.
    const isFixture = !!db.get("SELECT 1 FROM demo_config WHERE key=?", `fixture_reply:${req.id}`);
    if (req.target_company_id && !isFixture) for (const c of summary.categories) db.run("INSERT OR IGNORE INTO company_capabilities (company_id, category_key, label, capability_class, source_url, source_type, evidence_text, confidence) VALUES (?,?,?,?,?,?,?,?)", req.target_company_id, c.key, c.label, "PUBLICLY_CLAIMED_CAPABILITY", `field-request:${req.token}`, "USER_PROVIDED", `From material supplied at the event: "${c.passage}"`, 0.6);
    audit({ actorType: "agent", actorId: "email", companyId: req.company_id, action: "field_request.replied", entityType: "field_request", entityId: req.id, summary: `Reply received: ${(d.Attachments ?? []).length} attachment(s); gaps: ${summary.gaps.join(", ") || "none"}` });
    replies++;
    repliedIds.push(req.id);
  }
  return { checked: list.messages?.length ?? 0, replies, repliedIds };
}
export { json };

export interface Briefing {
  generatedAt: string;
  fromMaterial: { price: unknown; leadTimeDays: unknown; certifications: string[]; categories: string[]; gaps: string[]; photos: number };
  matchedNotices: { id: number; title: string | null; authority: string | null; url: string; deadline: string | null; country: string | null }[];
  buyerMandate: { maxUnitPrice: number | null; currency: string | null; maxLeadTimeDays: number | null; allowedPaymentTerms: string | null; autonomousAccept: boolean } | null;
  fit: { priceVsMandate: string; leadTimeVsMandate: string };
  negotiation: { id: number | null; decision: string };
}

/** Briefing after a reply: what the material says, which real open notices it may fit, and how it compares with OUR mandate. Optionally starts the SANDBOX autopilot. */
export function buildBriefing(requestId: number): { briefing: Briefing; startAutopilot: { negotiationId: number; rfqTerms: Record<string, unknown> } | null } {
  const db = getDb();
  const r = db.get<{ id: number; mission_id: number | null; company_id: number; target_company_id: number | null; event_id: number | null; summary: string | null; rfq_terms: string | null; auto_negotiate: number; negotiation_id: number | null; stand_hint: string | null }>("SELECT * FROM field_requests WHERE id=?", requestId);
  if (!r) throw new Error("Field request not found");
  const sum = json<(SpecExtraction & { photoCount?: number }) | null>(r.summary, null);
  if (!sum) throw new Error("No reply recorded yet");
  // The briefing is about what was ordered: the mission's own category wins; only without a mission do we fall back to the material's first category.
  const missionCat = r.mission_id ? json<{ categoryKey?: string | null }>(db.get<{ parsed: string | null }>("SELECT parsed FROM missions WHERE id=?", r.mission_id)?.parsed ?? null, {}).categoryKey : null;
  const cats = missionCat ? [missionCat] : sum.categories.slice(0, 1).map((c) => c.key);
  const seen = new Set<number>();
  const notices = cats.flatMap((k) => demandForCategory(k, { limit: 3 }).open).filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true))).slice(0, 3);
  const bp = db.get<{ max_unit_price: number | null; currency: string | null; max_lead_time_days: number | null; allowed_payment_terms: string | null; autonomous_accept: number }>("SELECT * FROM negotiation_policies WHERE company_id=? AND side='BUYER'", r.company_id);
  const price = sum.terms.unitPrice as number | undefined; const lead = sum.terms.leadTimeDays as number | undefined;
  const cmp = (v: number | undefined, lim: number | null | undefined, what: string) => v == null ? `${what} not in the material (gap)` : lim == null ? `${what} ${v}; no mandate limit set` : v <= lim ? `${what} ${v} is within mandate (${lim})` : `${what} ${v} exceeds mandate (${lim}); the agent will negotiate`;
  let neg: Briefing["negotiation"] = { id: r.negotiation_id, decision: "Autonomous negotiation not requested" };
  let start: { negotiationId: number; rfqTerms: Record<string, unknown> } | null = null;
  if (r.auto_negotiate && !r.negotiation_id) {
    if (!r.target_company_id) neg = { id: null, decision: "No target company; cannot negotiate" };
    else {
      const sp = db.get<{ simulated: number; autonomous_accept: number }>("SELECT * FROM negotiation_policies WHERE company_id=? AND side='SUPPLIER'", r.target_company_id);
      if (!bp?.autonomous_accept) neg = { id: null, decision: "Buyer mandate does not enable autonomous acceptance" };
      else if (!sp) neg = { id: null, decision: "No SANDBOX supplier mandate configured for the target; public companies are never impersonated" };
      else {
        const rfq = json<Record<string, unknown>>(r.rfq_terms, {});
        const negId = db.insert("negotiations", { mode: "SANDBOX", buyer_company_id: r.company_id, supplier_company_id: r.target_company_id, origin_event_id: r.event_id, subject: `${db.get<{ canonical_name: string }>("SELECT canonical_name FROM companies WHERE id=?", r.target_company_id)?.canonical_name ?? "Supplier"}${r.stand_hint ? ` (stand ${r.stand_hint})` : ""} — offer from event material`, state: "INITIAL_CONTACT", buyer_policy_snapshot: JSON.stringify(bp), supplier_policy_snapshot: JSON.stringify(sp) });
        db.insert("negotiation_transitions", { negotiation_id: negId, from_state: null, to_state: "INITIAL_CONTACT", actor: "agent:field", reason: "created from field reply" });
        db.update("field_requests", r.id, { negotiation_id: negId });
        neg = { id: negId, decision: "SANDBOX autopilot started (simulated supplier agent, mandate configured by the operator)" };
        start = { negotiationId: negId, rfqTerms: rfq };
      }
    }
  }
  const briefing: Briefing = {
    generatedAt: now(),
    fromMaterial: { price: price ?? null, leadTimeDays: lead ?? null, certifications: sum.certifications.map((c) => c.name), categories: cats, gaps: sum.gaps, photos: sum.photoCount ?? 0 },
    matchedNotices: notices.map((n) => ({ id: n.id, title: n.title, authority: n.authority, url: n.url, deadline: n.deadline, country: n.country })),
    buyerMandate: bp ? { maxUnitPrice: bp.max_unit_price, currency: bp.currency, maxLeadTimeDays: bp.max_lead_time_days, allowedPaymentTerms: bp.allowed_payment_terms, autonomousAccept: !!bp.autonomous_accept } : null,
    fit: { priceVsMandate: cmp(price, bp?.max_unit_price, "price"), leadTimeVsMandate: cmp(lead, bp?.max_lead_time_days, "lead time") },
    negotiation: neg,
  };
  db.update("field_requests", r.id, { briefing: JSON.stringify(briefing) });
  audit({ actorType: "agent", actorId: "matching", companyId: r.company_id, action: "field_request.briefing", entityType: "field_request", entityId: r.id, summary: `Briefing: ${briefing.fit.priceVsMandate}; ${briefing.matchedNotices.length} matching open notice(s)` });
  return { briefing, startAutopilot: start };
}

/** While-event discussion: after reading the material the agent writes back to the salesperson with exactly what is still missing. */
export async function sendDebrief(requestId: number): Promise<boolean> {
  const db = getDb();
  const r = db.get<{ token: string; mission_id: number | null; summary: string | null; stand_hint: string | null; rep_email: string; rep_name: string }>(
    "SELECT r.token, r.mission_id, r.summary, r.stand_hint, p.email rep_email, p.name rep_name FROM field_requests r JOIN field_reps p ON p.id=r.rep_id WHERE r.id=?", requestId);
  if (!r || !smtpReady()) return false;
  const gaps = json<{ gaps?: string[] }>(r.summary, {}).gaps ?? [];
  const subject = `Dopytanie${r.stand_hint ? ` — stoisko ${r.stand_hint}` : ""} [${r.token}]`;
  const body = [`Dzięki ${r.rep_name}, materiały dotarły i są przeanalizowane.`, "", gaps.length ? `Do domknięcia brakuje jeszcze: ${gaps.join("; ")}.` : "Niczego więcej nie potrzebuję.", gaps.length ? "Jeśli możesz, dopytaj o to przedstawiciela stoiska i odpisz w tym wątku." : "", "", "Negocjuję teraz z agentem dostawcy w ramach naszego mandatu.", "— Agent Arsenal AI"].filter((x, i, a) => !(x === "" && a[i - 1] === "")).join("\n");
  try {
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true" });
    await t.sendMail({ from: process.env.SMTP_FROM, to: r.rep_email, subject, text: body });
    logAgentEmail({ kind: "debrief", from: process.env.SMTP_FROM!, to: r.rep_email, subject, body, missionId: r.mission_id });
    return true;
  } catch { return false; }
}
