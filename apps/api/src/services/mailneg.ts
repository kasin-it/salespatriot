import nodemailer from "nodemailer";
import type { OfferTerms } from "@salespatriot/shared";
import { errorMessage, sleep } from "../lib/util.ts";
import { logAgentEmail } from "./emaillog.ts";

/** Offers between the two company agents travel as REAL emails over SMTP (Mailpit in the demo) and are read back from the mailbox. */
export const mailboxReady = (): boolean => !!(process.env.SMTP_HOST && process.env.SMTP_FROM && process.env.MAILPIT_URL);

const BEGIN = "---ARSENAL-OFFER-TERMS---";
const END = "---END-ARSENAL-OFFER-TERMS---";

export const offerSubject = (negId: number, version: number, kind: string, subject: string): string => `[NEG-${negId}-v${version}] ${kind}: ${subject}`;
export const agentAddress = (side: "buyer" | "supplier", company?: string): string => (company ? `agent.${company.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "supplier"}@arsenal.test` : `${side}-agent@arsenal.test`);

export function offerBody(a: { fromName: string; toName: string; kind: string; version: number; previousVersion: number | null; terms: OfferTerms; rationale?: string | null; mode: string }): string {
  const t = a.terms;
  const lines = [
    `${a.mode === "SANDBOX" ? "[SANDBOX — simulated counterparty agent] " : ""}${a.kind} v${a.version}${a.previousVersion ? ` (responds to v${a.previousVersion})` : ""}`,
    `From: ${a.fromName} → To: ${a.toName}`, "",
    t.quantity != null ? `Quantity: ${t.quantity}` : null, t.unitPrice != null ? `Unit price: ${t.unitPrice} ${t.currency ?? ""}` : null,
    t.leadTimeDays != null ? `Lead time: ${t.leadTimeDays} days` : null, t.paymentTerms ? `Payment terms: ${t.paymentTerms}` : null, t.deliveryTerms ? `Delivery terms: ${t.deliveryTerms}` : null,
    t.deliveryLocation ? `Delivery location: ${t.deliveryLocation}` : null, t.validUntil ? `Valid until: ${t.validUntil}` : null, a.rationale ? `\nNote: ${a.rationale}` : null,
    "", "Machine-readable terms (the receiving agent reads this block):", BEGIN, JSON.stringify(t), END,
  ].filter((x): x is string => x !== null);
  return lines.join("\n");
}

export async function sendOfferEmail(a: { negId: number; version: number; kind: string; subject: string; from: "buyer" | "supplier"; fromName: string; toName: string; terms: OfferTerms; previousVersion: number | null; rationale?: string | null; mode: string }): Promise<string> {
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true" });
  const supplierName = a.from === "supplier" ? a.fromName : a.toName;
  const to = agentAddress(a.from === "buyer" ? "supplier" : "buyer", a.from === "buyer" ? supplierName : undefined);
  const fromAddr = agentAddress(a.from, a.from === "supplier" ? supplierName : undefined);
  const subject = offerSubject(a.negId, a.version, a.kind, a.subject);
  const text = offerBody({ ...a, mode: a.mode });
  const info = await t.sendMail({ from: fromAddr, to, subject, text });
  logAgentEmail({ kind: "offer", from: fromAddr, to, subject, body: text.replace(/\n*Machine-readable terms[\s\S]*$/, "") });
  return info.messageId;
}

/** Read an offer back out of the mailbox. Returns null if it never arrives or cannot be parsed. */
export async function readOfferEmail(negId: number, version: number): Promise<{ terms: OfferTerms; messageId: string } | null> {
  const base = process.env.MAILPIT_URL!;
  const tag = `[NEG-${negId}-v${version}]`;
  for (let i = 0; i < 12; i++) {
    try {
      const r = (await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`subject:"${tag}"`)}`)).json()) as { messages?: { ID: string }[] };
      const id = r.messages?.[0]?.ID;
      if (id) {
        const d = (await (await fetch(`${base}/api/v1/message/${id}`)).json()) as { Text?: string };
        const m = new RegExp(`${BEGIN}\\s*([\\s\\S]*?)\\s*${END}`).exec(d.Text ?? "");
        if (m) return { terms: JSON.parse(m[1]!) as OfferTerms, messageId: id };
      }
    } catch (e) { void errorMessage(e); }
    await sleep(250);
  }
  return null;
}

/** Generic agent-to-agent email (pre-event conversation). The body carries a machine-readable JSON block the receiving agent parses. */
const BLOCK_BEGIN = "---ARSENAL-AGENT-DATA---";
const BLOCK_END = "---END-ARSENAL-AGENT-DATA---";
export const withBlock = (text: string, data: unknown): string => `${text}\n\n(Machine-readable block for the receiving agent)\n${BLOCK_BEGIN}\n${JSON.stringify(data)}\n${BLOCK_END}`;

/** `company` gives the supplier-side agent its own address, so a thread with each exhibitor is a separate conversation. */
export async function sendAgentEmail(a: { subject: string; from: "buyer" | "supplier"; text: string; company?: string }): Promise<void> {
  const t = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT ?? 587), secure: process.env.SMTP_SECURE === "true" });
  const addr = (side: "buyer" | "supplier") => agentAddress(side, side === "supplier" ? a.company : undefined);
  const from = addr(a.from); const to = addr(a.from === "buyer" ? "supplier" : "buyer");
  await t.sendMail({ from, to, subject: a.subject, text: a.text });
  logAgentEmail({ kind: "pre_event", from, to, subject: a.subject, body: a.text.replace(/\n*\(Machine-readable block[\s\S]*$/, "") });
}

/** Reads one agent email back from the mailbox by subject tag and returns its parsed data block. */
export async function readAgentEmail(tag: string): Promise<{ data: Record<string, unknown> | null; text: string; messageId: string } | null> {
  const base = process.env.MAILPIT_URL!;
  for (let i = 0; i < 16; i++) {
    try {
      const r = (await (await fetch(`${base}/api/v1/search?query=${encodeURIComponent(`subject:"${tag}"`)}`)).json()) as { messages?: { ID: string }[] };
      const id = r.messages?.[0]?.ID;
      if (id) {
        const d = (await (await fetch(`${base}/api/v1/message/${id}`)).json()) as { Text?: string };
        const m = new RegExp(`${BLOCK_BEGIN}\\s*([\\s\\S]*?)\\s*${BLOCK_END}`).exec(d.Text ?? "");
        let data: Record<string, unknown> | null = null;
        try { data = m ? (JSON.parse(m[1]!) as Record<string, unknown>) : null; } catch { data = null; }
        return { data, text: d.Text ?? "", messageId: id };
      }
    } catch (e) { void errorMessage(e); }
    await sleep(250);
  }
  return null;
}
