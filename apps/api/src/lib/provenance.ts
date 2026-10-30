import type { FactKind, SourceType, VerificationStatus } from "@salespatriot/shared";
import { getDb } from "../db/db.ts";
import { now } from "./util.ts";

export interface FactInput {
  entityType: "company" | "event" | "procurement";
  entityId: number;
  field: string;
  value: string | null;
  sourceUrl: string | null;
  sourceType: SourceType;
  factKind: FactKind;
  evidence: string | null;
  confidence: number;
  verification?: VerificationStatus;
  userId?: number;
}

/**
 * Record a fact. Same (entity, field, value, source) refreshes last_verified_at;
 * a different value for the same field is stored alongside, preserving conflicts.
 */
export function recordFact(f: FactInput): number {
  const db = getDb();
  const source = f.sourceUrl ? db.get<{ id: number }>("SELECT id FROM sources WHERE url = ?", f.sourceUrl) : undefined;
  const existing = db.get<{ id: number }>(
    "SELECT id FROM facts WHERE entity_type=? AND entity_id=? AND field_name=? AND field_value IS ? AND source_url IS ?",
    f.entityType, f.entityId, f.field, f.value, f.sourceUrl,
  );
  if (existing) {
    db.update("facts", existing.id, { last_verified_at: now(), evidence_text: f.evidence ?? undefined });
    return existing.id;
  }
  return db.insert("facts", {
    entity_type: f.entityType,
    entity_id: f.entityId,
    field_name: f.field,
    field_value: f.value,
    source_id: source?.id ?? null,
    source_url: f.sourceUrl,
    source_type: f.sourceType,
    fact_kind: f.factKind,
    evidence_text: f.evidence,
    last_verified_at: now(),
    confidence: f.confidence,
    verification_status: f.verification ?? "UNVERIFIED",
    created_by_user_id: f.userId ?? null,
  });
}

export function upsertSource(url: string, sourceType: SourceType, title?: string | null): number {
  const db = getDb();
  const row = db.get<{ id: number }>("SELECT id FROM sources WHERE url = ?", url);
  if (row) return row.id;
  let domain: string | null = null;
  try {
    domain = new URL(url).hostname;
  } catch {}
  return db.insert("sources", { url, domain, source_type: sourceType, title: title ?? null });
}
