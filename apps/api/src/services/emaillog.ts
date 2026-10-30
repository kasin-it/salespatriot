import { getDb } from "../db/db.ts";

/** Which mission a subject belongs to: [PRE-<mission>-n], [NEG-<negotiation>…] or an [ARS-token] field request. */
export function missionFromSubject(subject: string): number | null {
  const db = getDb();
  const pre = /\[(?:PRE|POST)-(\d+)-/.exec(subject);
  if (pre) return Number(pre[1]);
  const neg = /\[NEG-(\d+)[-\]]/.exec(subject);
  if (neg) return db.get<{ mission_id: number | null }>("SELECT mission_id FROM field_requests WHERE negotiation_id=?", Number(neg[1]))?.mission_id ?? null;
  const ars = /\[(ARS-[A-Z0-9]+)\]/.exec(subject);
  if (ars) return db.get<{ mission_id: number | null }>("SELECT mission_id FROM field_requests WHERE token=?", ars[1]!)?.mission_id ?? null;
  return null;
}

/** Every email an agent (or the salesperson's reply) sends is recorded, so the Command Center can show exactly what went out. */
export function logAgentEmail(a: { kind: "pre_event" | "offer" | "field_request" | "field_reply" | "confirmation" | "followup" | "debrief"; from: string; to: string; subject: string; body: string; missionId?: number | null }): void {
  try {
    getDb().insert("agent_emails", { mission_id: a.missionId ?? missionFromSubject(a.subject), kind: a.kind, from_addr: a.from, to_addr: a.to, subject: a.subject, body: a.body.slice(0, 6000) });
  } catch { /* logging must never break the flow */ }
}
