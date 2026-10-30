import type { CompanyIdentityState, FactKind, SourceType } from "@salespatriot/shared";
import { getDb } from "../db/db.ts";
import { domainOf, normalizeCompanyName, normalizeUrl, now } from "../lib/util.ts";
import { audit } from "../lib/audit.ts";
import { recordFact } from "../lib/provenance.ts";

export interface CompanyCandidate {
  name: string;
  country?: string | null;
  website?: string | null;
  origin: string;
  identifiers?: { scheme: string; value: string }[];
  sourceUrl: string | null;
  sourceType: SourceType;
  factKind: FactKind;
  evidence: string | null;
}

export interface ResolveResult {
  companyId: number;
  created: boolean;
  matchedBy: "identifier" | "domain" | "name+country" | "new";
}

/**
 * Canonical company resolution. Order of trust: registry identifier > official website domain > exact normalised name in the same country.
 * Similar names alone never merge; an ambiguous name match with no corroboration creates a separate record flagged NEEDS_REVIEW.
 */
export function resolveCompany(c: CompanyCandidate): ResolveResult {
  const db = getDb();
  const domain = domainOf(c.website);
  const norm = normalizeCompanyName(c.name);
  let id: number | undefined;
  let by: ResolveResult["matchedBy"] = "new";

  for (const ident of c.identifiers ?? []) {
    const hit = db.get<{ company_id: number }>("SELECT company_id FROM company_identifiers WHERE scheme=? AND value=?", ident.scheme, ident.value);
    if (hit) { id = hit.company_id; by = "identifier"; break; }
  }
  if (!id && domain) {
    const hit = db.get<{ id: number }>("SELECT id FROM companies WHERE website_domain = ?", domain);
    if (hit) { id = hit.id; by = "domain"; }
  }
  let needsReview = false;
  if (!id && norm && c.country) {
    const hits = db.all<{ id: number; website_domain: string | null }>(
      `SELECT DISTINCT c.id, c.website_domain FROM companies c LEFT JOIN company_aliases a ON a.company_id = c.id
       WHERE c.country = ? AND (c.normalized_name = ? OR a.normalized = ?)`, c.country, norm, norm);
    // A name match is only accepted when it is unique and the website does not contradict it.
    const compatible = hits.filter((h) => !domain || !h.website_domain || h.website_domain === domain);
    if (compatible.length === 1) { id = compatible[0]!.id; by = "name+country"; }
    else if (hits.length > 0) needsReview = true;
  }

  const t = now();
  if (id) {
    const row = db.get<{ website: string | null; country: string | null; canonical_name: string }>("SELECT website, country, canonical_name FROM companies WHERE id=?", id)!;
    db.update("companies", id, {
      website: row.website ?? normalizeUrl(c.website) ?? undefined,
      website_domain: row.website ? undefined : (domain ?? undefined),
      country: row.country ?? c.country ?? undefined,
      updated_at: t,
    });
    if (row.canonical_name !== c.name) addAlias(id, c.name, c.sourceUrl);
    attachIdentifiers(id, c);
    return { companyId: id, created: false, matchedBy: by };
  }

  // Website domain is unique per company; if another record already owns it we would have matched above.
  id = db.insert("companies", {
    canonical_name: c.name,
    normalized_name: norm,
    country: c.country ?? null,
    website: normalizeUrl(c.website),
    website_domain: domain,
    identity_state: needsReview ? "NEEDS_REVIEW" : (c.identifiers?.length ? "IDENTIFIED" : "UNVERIFIED"),
    origin: c.origin,
  });
  attachIdentifiers(id, c);
  if (c.sourceUrl) {
    recordFact({ entityType: "company", entityId: id, field: "name", value: c.name, sourceUrl: c.sourceUrl, sourceType: c.sourceType, factKind: c.factKind, evidence: c.evidence, confidence: 0.9 });
    if (c.website) recordFact({ entityType: "company", entityId: id, field: "website", value: normalizeUrl(c.website), sourceUrl: c.sourceUrl, sourceType: c.sourceType, factKind: c.factKind, evidence: c.evidence, confidence: 0.85 });
  }
  indexCompany(id);
  audit({ actorType: "system", action: "company.created", entityType: "company", entityId: id, summary: `Company "${c.name}" created from ${c.origin}${needsReview ? " (possible duplicate — needs review)" : ""}` });
  return { companyId: id, created: true, matchedBy: "new" };
}

function attachIdentifiers(id: number, c: CompanyCandidate): void {
  const db = getDb();
  for (const ident of c.identifiers ?? []) {
    db.run("INSERT OR IGNORE INTO company_identifiers (company_id, scheme, value, source_url) VALUES (?,?,?,?)", id, ident.scheme, ident.value, c.sourceUrl);
  }
}

export function addAlias(companyId: number, alias: string, sourceUrl: string | null): void {
  getDb().run("INSERT OR IGNORE INTO company_aliases (company_id, alias, normalized, source_url) VALUES (?,?,?,?)", companyId, alias, normalizeCompanyName(alias), sourceUrl);
}

export function setIdentityState(companyId: number, state: CompanyIdentityState, why: string): void {
  getDb().update("companies", companyId, { identity_state: state, updated_at: now() });
  audit({ actorType: "system", action: "company.identity_state", entityType: "company", entityId: companyId, summary: `Identity state → ${state}: ${why}` });
}

export function indexCompany(id: number): void {
  const db = getDb();
  const c = db.get<{ canonical_name: string; legal_name: string | null; description: string | null; country: string | null; website_domain: string | null }>("SELECT * FROM companies WHERE id=?", id);
  if (!c) return;
  const prods = db.all<{ name: string }>("SELECT name FROM company_products WHERE company_id=?", id).map((p) => p.name);
  const caps = db.all<{ label: string }>("SELECT label FROM company_capabilities WHERE company_id=?", id).map((p) => p.label);
  db.run("DELETE FROM search_index WHERE entity_type='company' AND entity_id=?", id);
  db.run("INSERT INTO search_index (entity_type, entity_id, title, body) VALUES ('company', ?, ?, ?)", id, c.canonical_name, [c.legal_name, c.description, c.country, c.website_domain, ...prods, ...caps].filter(Boolean).join(" "));
}
