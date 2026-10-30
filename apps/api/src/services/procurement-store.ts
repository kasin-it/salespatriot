import { getDb, json } from "../db/db.ts";
import { now, sha256, normalizeCompanyName } from "../lib/util.ts";
import { audit } from "../lib/audit.ts";
import { upsertSource } from "../lib/provenance.ts";
import { categoriesForCpv } from "../lib/taxonomy.ts";
import type { NormalizedNotice } from "../connectors/types.ts";

/** Fraction of key fields actually present. Missing stays NULL; this indicator just reports it. */
export function completeness(n: NormalizedNotice): { score: number; missing: string[] } {
  const checks: [string, boolean][] = [
    ["title", !!n.title],
    ["description", !!n.description],
    ["cpv_codes", n.cpvCodes.length > 0],
    ["deadline", !!n.deadline],
    ["estimated_value", n.estimatedValue != null],
    ["contracting_authority", !!n.contractingAuthority],
    ["publication_date", !!n.publicationDate],
    ["country", !!n.country],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([k]) => k);
  return { score: Math.round(((checks.length - missing.length) / checks.length) * 100) / 100, missing };
}

export function tagAuthority(name: string | null): { tags: string[] } {
  const db = getDb();
  const tags: string[] = [];
  if (!name) return { tags };
  const norm = normalizeCompanyName(name);
  const raw = name.toLowerCase();
  for (const m of db.all<{ canonical_key: string; match_patterns: string }>("SELECT canonical_key, match_patterns FROM authority_mappings")) {
    if (json<string[]>(m.match_patterns, []).some((p) => raw.includes(p) || norm.includes(normalizeCompanyName(p)))) tags.push(m.canonical_key);
  }
  return { tags };
}

/** Insert or update a notice by (source_key, source_notice_id). Returns what happened. */
export function storeNotice(n: NormalizedNotice): "created" | "updated" | "unchanged" {
  const db = getDb();
  const payload = JSON.stringify(n.originalPayload);
  const { score, missing } = completeness(n);
  const { tags } = tagAuthority(n.contractingAuthority);
  upsertSource(n.sourceUrl, "PROCUREMENT_PORTAL", n.title);
  const isOpen = n.deadline ? Date.parse(n.deadline) > Date.now() : null;
  const isCall = /^(cn|pin|competition|contractnotice|contract notice)/i.test(n.noticeType ?? "");
  const demand = isCall && isOpen !== false ? "CONFIRMED_DEMAND" : "HISTORICAL_DEMAND";
  const status = isCall ? (isOpen === false ? "CLOSED" : isOpen ? "OPEN" : "OPEN_DEADLINE_UNKNOWN") : /result|can-|award/i.test(n.noticeType ?? "") ? "AWARDED" : (n.noticeType ?? "UNKNOWN");
  const row = {
    source_key: n.sourceKey,
    retrieved_via: n.retrievedVia,
    source_notice_id: n.sourceNoticeId,
    source_url: n.sourceUrl,
    publication_date: n.publicationDate,
    original_payload: payload,
    contracting_authority: n.contractingAuthority,
    authority_national_id: n.authorityNationalId,
    authority_tags: JSON.stringify(tags),
    title: n.title,
    description: n.description,
    cpv_codes: JSON.stringify(n.cpvCodes),
    deadline: n.deadline,
    estimated_value: n.estimatedValue,
    currency: n.currency,
    lots: JSON.stringify(n.lots),
    technical_requirements: n.technicalRequirements,
    notice_type: n.noticeType,
    procurement_status: n.procurementStatus ?? status,
    legal_basis: n.legalBasis,
    contract_nature: n.contractNature,
    country: n.country,
    awarded_suppliers: JSON.stringify(n.awardedSuppliers),
    data_completeness: score,
    missing_fields: JSON.stringify(missing),
    verification_status: "VERIFIED",
    demand_class: demand,
    content_hash: "",
  };
  const hash = sha256(payload + JSON.stringify({ ...row, content_hash: undefined, original_payload: undefined, demand_class: undefined, procurement_status: undefined }));
  row.content_hash = hash;
  const existing = db.get<{ id: number; content_hash: string }>("SELECT id, content_hash FROM procurement_notices WHERE source_key=? AND source_notice_id=?", n.sourceKey, n.sourceNoticeId);
  let result: "created" | "updated" | "unchanged";
  let id: number;
  if (!existing) {
    id = db.insert("procurement_notices", row);
    result = "created";
  } else if (existing.content_hash === hash) {
    return "unchanged";
  } else {
    id = existing.id;
    db.update("procurement_notices", id, { ...row, updated_at: now(), retrieval_timestamp: now() });
    result = "updated";
  }
  const cats = categoriesForCpv(n.cpvCodes);
  db.run("DELETE FROM search_index WHERE entity_type='notice' AND entity_id=?", id);
  db.run("INSERT INTO search_index (entity_type, entity_id, title, body) VALUES ('notice', ?, ?, ?)", id, n.title ?? n.sourceNoticeId, [n.contractingAuthority, n.description, n.cpvCodes.join(" "), cats.join(" ")].filter(Boolean).join(" "));
  return result;
}

export function recordConnectorRun(key: string, patch: { ok: boolean; error?: string | null; fetched?: number; created?: number; updated?: number; failed?: number; cursor?: string | null; totalDelta?: number }): void {
  const db = getDb();
  const t = now();
  db.run(
    `UPDATE connector_status SET last_attempt_at = ?, status = ?, last_error = ?,
       last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END,
       last_new = ?, last_updated = ?, failed_requests = failed_requests + ?,
       records_total = (SELECT COUNT(*) FROM procurement_notices WHERE source_key = ?),
       sync_cursor = COALESCE(?, sync_cursor) WHERE key = ?`,
    t, patch.ok ? "CONNECTED" : "ERROR", patch.error ?? null, patch.ok ? 1 : 0, t, patch.created ?? 0, patch.updated ?? 0, patch.failed ?? 0, key, patch.cursor ?? null, key,
  );
  if (key === "ted") {
    // Mapping connectors derive their state from real TED data they have retrieved, never from assumption.
    for (const [mk, tag] of [["agencja_uzbrojenia", "AGENCJA_UZBROJENIA"], ["eda_ted", "EDA"]] as const) {
      const n = db.get<{ n: number }>("SELECT COUNT(*) n FROM procurement_notices WHERE source_key='ted' AND authority_tags LIKE ?", `%"${tag}"%`)?.n ?? 0;
      db.run("UPDATE connector_status SET records_total = ?, last_attempt_at = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, status = CASE WHEN ? THEN 'CONNECTED' ELSE status END WHERE key = ?", n, t, patch.ok && n > 0 ? 1 : 0, t, patch.ok && n > 0 ? 1 : 0, mk);
    }
  }
  audit({ actorType: "system", action: "connector.sync", entityType: "connector", summary: `${key}: ${patch.ok ? "ok" : "error"} fetched=${patch.fetched ?? 0} new=${patch.created ?? 0} updated=${patch.updated ?? 0}${patch.error ? " — " + patch.error : ""}` });
}
