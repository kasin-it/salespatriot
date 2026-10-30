import nodemailer from "nodemailer";
import { getDb } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { errorMessage, now } from "../lib/util.ts";
import type { OfferTerms } from "@salespatriot/shared";

export function smtpConfigured(): boolean {
  return !!(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

export interface DraftEmailInput {
  companyId: number;
  contactId: number;
  subject: string;
  body: string;
  negotiationId?: number;
  createdBy: string;
}

/** Only addresses already stored as public contacts of a company can be addressed. Result is always a DRAFT; sending needs an explicit approval. */
export function draftEmail(i: DraftEmailInput): number {
  const db = getDb();
  const contact = db.get<{ id: number; kind: string; value: string; company_id: number }>("SELECT * FROM company_contacts WHERE id = ?", i.contactId);
  if (!contact || contact.kind !== "email") throw new Error("Recipient must be a stored email contact");
  if (contact.company_id === i.companyId) throw new Error("Recipient belongs to the sending company");
  const id = db.insert("email_messages", {
    company_id: i.companyId, contact_id: contact.id, direction: "OUT", to_address: contact.value, subject: i.subject, body: i.body, status: "DRAFT", mode: smtpConfigured() ? "READY" : "DRAFT_ONLY", created_by: i.createdBy,
  });
  audit({ actorType: "user", actorId: i.createdBy, companyId: i.companyId, action: "email.drafted", entityType: "email", entityId: id, summary: `Draft to ${contact.value}: ${i.subject}` });
  return id;
}

export function rfqEmailBody(a: { buyerName: string; subject: string; terms: OfferTerms; note?: string }): string {
  const lines = [
    `Request for quotation — ${a.subject}`,
    "",
    `${a.buyerName} would like to request a quotation.`,
    "",
    a.terms.quantity != null ? `Quantity: ${a.terms.quantity}` : null,
    a.terms.deliveryLocation ? `Delivery location: ${a.terms.deliveryLocation}` : null,
    a.terms.technicalSpecs ? `Technical requirements: ${a.terms.technicalSpecs}` : null,
    a.terms.validUntil ? `Please respond by: ${a.terms.validUntil}` : null,
    "",
    "Please include unit price, currency, lead time, delivery terms, payment terms and offer validity.",
    a.note ?? null,
  ].filter((x): x is string => x !== null);
  return lines.join("\n");
}

/** Send an approved draft. Without SMTP configuration nothing is sent and the message stays a draft. */
export async function sendApprovedEmail(emailId: number, approvedBy: number): Promise<{ sent: boolean; reason?: string }> {
  const db = getDb();
  const m = db.get<{ id: number; to_address: string; subject: string; body: string; status: string; company_id: number }>("SELECT * FROM email_messages WHERE id = ?", emailId);
  if (!m || m.status !== "DRAFT") throw new Error("Only DRAFT emails can be sent");
  if (!smtpConfigured()) {
    db.update("email_messages", emailId, { status: "NOT_SENT_NO_PROVIDER", error: "SMTP is not configured; message was not sent" });
    audit({ actorType: "user", actorId: approvedBy, companyId: m.company_id, action: "email.not_sent", entityType: "email", entityId: emailId, summary: "Send requested but no SMTP provider is configured" });
    return { sent: false, reason: "SMTP_HOST / SMTP_FROM not configured. Message kept as a record, NOT sent." };
  }
  try {
    const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true", auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined });
    const info = await t.sendMail({ from: process.env.SMTP_FROM, to: m.to_address, subject: m.subject, text: m.body });
    db.update("email_messages", emailId, { status: "SENT", sent_at: now(), provider: "smtp", provider_message_id: info.messageId, mode: "REAL" });
    audit({ actorType: "user", actorId: approvedBy, companyId: m.company_id, action: "email.sent", entityType: "email", entityId: emailId, summary: `Email sent to ${m.to_address}` });
    return { sent: true };
  } catch (e) {
    db.update("email_messages", emailId, { status: "FAILED", error: errorMessage(e) });
    throw e;
  }
}

/** Record a reply the user pasted/forwarded. Parsing extracts only values that literally appear in the text. */
export function recordIncomingEmail(a: { companyId: number; fromAddress: string; subject: string; body: string; negotiationId?: number }): { id: number; parsed: Partial<OfferTerms> } {
  const parsed = parseTermsFromText(a.body);
  const id = getDb().insert("email_messages", { company_id: a.companyId, direction: "IN", from_address: a.fromAddress, subject: a.subject, body: a.body, status: "RECEIVED", mode: "REAL", parsed_terms: JSON.stringify(parsed), created_by: "user" });
  audit({ actorType: "user", companyId: a.companyId, action: "email.received_recorded", entityType: "email", entityId: id, summary: `Incoming email recorded from ${a.fromAddress}` });
  return { id, parsed };
}

/** Wording that names no actual term ("agreed per order", "tbd"): treated as not stated. */
const PLACEHOLDER = /\b(agreed|to be agreed|tbd|tba|negotiable|on request|per order|individually|indywidualnie)\b/i;

/** Deterministic extraction of labelled terms. Anything not labelled stays null — the user confirms before it becomes an offer. */
export function parseTermsFromText(text: string): Partial<OfferTerms> {
  const out: Partial<OfferTerms> = {};
  const num = (s: string) => Number(s.replace(/[\s,](?=\d{3}\b)/g, "").replace(",", "."));
  const price = /(?:unit\s*price|price(?:\s*per\s*unit)?|cena(?:\s*jednostkowa)?)\s*[:=]?\s*(?:(EUR|PLN|USD|GBP|€|zł)\s*)?(\d[\d\s.,]*\d|\d)\s*(EUR|PLN|USD|GBP|€|zł)?/i.exec(text);
  if (price) {
    out.unitPrice = num(price[2]!);
    const cur = (price[1] ?? price[3])?.toUpperCase();
    out.currency = cur === "€" ? "EUR" : cur === "ZŁ" ? "PLN" : (cur ?? null);
  }
  const qty = /(?<!order\s)(?<!minimum\s)(?:quantity|qty|ilo[śs][ćc])\s*[:=]?\s*(\d[\d\s.,]*)/i.exec(text);
  if (qty) out.quantity = num(qty[1]!);
  const moq = /(?:minimum order quantity|moq)\s*[:=]?\s*(\d[\d\s.,]*)/i.exec(text);
  if (moq) out.moq = num(moq[1]!);
  const lead = /lead\s*time\s*[:=]?\s*(\d+)\s*(day|week|d\b|tydz)/i.exec(text);
  if (lead) out.leadTimeDays = Number(lead[1]) * (/week|tydz/i.test(lead[2]!) ? 7 : 1);
  const pay = /payment\s*terms?\s*[:=]?\s*([^\n.;]{3,60})/i.exec(text);
  if (pay && !PLACEHOLDER.test(pay[1]!)) out.paymentTerms = pay[1]!.trim();
  const del = /(?:delivery\s*terms?|incoterms?)\s*[:=]?\s*([^\n.;]{2,60})/i.exec(text);
  if (del && !PLACEHOLDER.test(del[1]!)) out.deliveryTerms = del[1]!.trim();
  const valid = /(?:valid(?:\s*until)?|offer\s*validity)\s*[:=]?\s*(20\d\d-\d\d-\d\d)/i.exec(text);
  if (valid) out.validUntil = `${valid[1]}T23:59:59Z`;
  return out;
}

export function prepareCall(a: { companyId: number; contactId: number; purpose: string; script: string; createdBy: string }): number {
  const db = getDb();
  const c = db.get<{ kind: string; value: string }>("SELECT kind, value FROM company_contacts WHERE id=?", a.contactId);
  if (!c || c.kind !== "phone") throw new Error("Recipient must be a stored phone contact");
  const disclosure = "This is an automated AI assistant calling on behalf of a business inquiry. This call may be recorded only with your consent.";
  const id = db.insert("voice_calls", { company_id: a.companyId, contact_id: a.contactId, to_number: c.value, purpose: a.purpose, script: a.script, ai_disclosure: disclosure, status: twilioConfigured() ? "DRAFT" : "SIMULATION_ONLY", created_by: a.createdBy });
  audit({ actorType: "user", actorId: a.createdBy, companyId: a.companyId, action: "voice.prepared", entityType: "voice_call", entityId: id, summary: `Call script prepared (${twilioConfigured() ? "provider configured" : "no provider: no call will be placed"})` });
  return id;
}
export const twilioConfigured = (): boolean => !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
