import { getDb } from "../db/db.ts";
import { politeFetch, setHostInterval } from "../lib/http.ts";
import { normalizeCompanyName, now } from "../lib/util.ts";
import { recordFact, upsertSource } from "../lib/provenance.ts";
import { addAlias, setIdentityState } from "./companies.ts";
import { audit } from "../lib/audit.ts";

setHostInterval("api.gleif.org", 1100);
setHostInterval("ec.europa.eu", 1500);

interface GleifRecord {
  id: string;
  attributes: {
    lei: string;
    entity: {
      legalName: { name: string };
      otherNames?: { name: string }[];
      legalAddress?: { addressLines?: string[]; city?: string; country?: string; postalCode?: string };
      registeredAs?: string | null;
      registeredAt?: { id?: string } | null;
      status?: string;
      jurisdiction?: string;
    };
    registration?: { status?: string; lastUpdateDate?: string };
  };
}

export interface GleifLookup {
  records: GleifRecord[];
  url: string;
}

export async function gleifSearch(by: { lei?: string; name?: string; registrationNumber?: string }, taskId?: number): Promise<GleifLookup> {
  let url: string;
  if (by.lei) url = `https://api.gleif.org/api/v1/lei-records?filter%5Blei%5D=${encodeURIComponent(by.lei)}`;
  else if (by.registrationNumber) url = `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.registeredAs%5D=${encodeURIComponent(by.registrationNumber)}&page%5Bsize%5D=5`;
  else if (by.name) url = `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=${encodeURIComponent(by.name)}&page%5Bsize%5D=5`;
  else throw new Error("gleifSearch needs lei, name or registrationNumber");
  const res = await politeFetch(url, { respectRobots: false, timeoutMs: 90_000, retries: 2, taskId, headers: { accept: "application/vnd.api+json" } });
  if (res.status !== 200) throw new Error(`GLEIF HTTP ${res.status}`);
  return { records: (JSON.parse(res.body) as { data: GleifRecord[] }).data ?? [], url };
}

/**
 * Verify identity with GLEIF. An exact legal-name match (after normalisation) in the same country is IDENTIFIED;
 * a registry ID or LEI supplied by the user that GLEIF confirms is VERIFIED. Anything else is left unmerged.
 */
export async function verifyViaGleif(companyId: number, taskId?: number): Promise<{ state: string; lei: string | null; note: string }> {
  const db = getDb();
  const c = db.get<{ canonical_name: string; legal_name: string | null; country: string | null }>("SELECT canonical_name, legal_name, country FROM companies WHERE id=?", companyId);
  if (!c) throw new Error("Company not found");
  const ids = db.all<{ scheme: string; value: string }>("SELECT scheme, value FROM company_identifiers WHERE company_id=?", companyId);
  const lei = ids.find((i) => i.scheme === "LEI")?.value;
  const reg = ids.find((i) => i.scheme === "REGISTRATION_NUMBER" || i.scheme === "KRS" || i.scheme === "NIP")?.value;
  let lookup: GleifLookup;
  let strong = false;
  if (lei) { lookup = await gleifSearch({ lei }, taskId); strong = true; }
  else if (reg) { lookup = await gleifSearch({ registrationNumber: reg }, taskId); strong = true; }
  else lookup = await gleifSearch({ name: c.legal_name ?? c.canonical_name }, taskId);
  upsertSource(lookup.url, "GOVERNMENT_REGISTRY", "GLEIF LEI record search");
  const want = normalizeCompanyName(c.legal_name ?? c.canonical_name);
  const hit = lookup.records.find((r) => {
    const e = r.attributes.entity;
    const sameName = normalizeCompanyName(e.legalName.name) === want || (e.otherNames ?? []).some((o) => normalizeCompanyName(o.name) === want);
    const sameCountry = !c.country || e.legalAddress?.country === c.country;
    return strong ? true : sameName && sameCountry;
  });
  if (!hit) {
    db.run("UPDATE connector_status SET last_attempt_at=?, last_success_at=?, status='CONNECTED', last_error=NULL WHERE key='gleif'", now(), now());
    return { state: "UNCHANGED", lei: null, note: "No exact GLEIF match; entity may have no LEI. Identity not verified." };
  }
  const e = hit.attributes.entity;
  const recUrl = `https://api.gleif.org/api/v1/lei-records/${hit.attributes.lei}`;
  upsertSource(recUrl, "GOVERNMENT_REGISTRY", `GLEIF ${hit.attributes.lei}`);
  const evidence = `GLEIF record ${hit.attributes.lei}: legalName="${e.legalName.name}", status=${hit.attributes.registration?.status ?? "n/a"}, address=${[...(e.legalAddress?.addressLines ?? []), e.legalAddress?.postalCode, e.legalAddress?.city, e.legalAddress?.country].filter(Boolean).join(", ")}`;
  const f = (field: string, value: string | null) =>
    recordFact({ entityType: "company", entityId: companyId, field, value, sourceUrl: recUrl, sourceType: "GOVERNMENT_REGISTRY", factKind: "OFFICIALLY_VERIFIED", evidence, confidence: 0.97, verification: "VERIFIED" });
  f("legal_name", e.legalName.name);
  f("lei", hit.attributes.lei);
  f("registered_address", [...(e.legalAddress?.addressLines ?? []), e.legalAddress?.postalCode, e.legalAddress?.city, e.legalAddress?.country].filter(Boolean).join(", "));
  if (e.registeredAs) f("registration_number", e.registeredAs);
  db.run("INSERT OR IGNORE INTO company_identifiers (company_id, scheme, value, source_url, verified, verified_at) VALUES (?,?,?,?,1,?)", companyId, "LEI", hit.attributes.lei, recUrl, now());
  db.run("UPDATE company_identifiers SET verified=1, verified_at=?, source_url=? WHERE company_id=? AND scheme='LEI' AND value=?", now(), recUrl, companyId, hit.attributes.lei);
  if (e.registeredAs) db.run("INSERT OR IGNORE INTO company_identifiers (company_id, scheme, value, source_url, verified, verified_at) VALUES (?,?,?,?,1,?)", companyId, "REGISTRATION_NUMBER", e.registeredAs, recUrl, now());
  for (const o of e.otherNames ?? []) addAlias(companyId, o.name, recUrl);
  db.update("companies", companyId, { legal_name: e.legalName.name, country: c.country ?? e.legalAddress?.country ?? undefined, updated_at: now() });
  // VERIFIED needs an identifier supplied independently of the name (LEI / registration number); an exact name+country match is only IDENTIFIED.
  const state = strong ? "VERIFIED" : "IDENTIFIED";
  setIdentityState(companyId, hit.attributes.registration?.status === "LAPSED" || e.status === "INACTIVE" ? "INACTIVE" : state, `GLEIF ${hit.attributes.lei}`);
  db.run("UPDATE connector_status SET last_attempt_at=?, last_success_at=?, status='CONNECTED', last_error=NULL, records_total=records_total+1 WHERE key='gleif'", now(), now());
  return { state, lei: hit.attributes.lei, note: evidence };
}

const EU = new Set(["AT","BE","BG","CY","CZ","DE","DK","EE","ES","FI","FR","GR","HR","HU","IE","IT","LT","LU","LV","MT","NL","PL","PT","RO","SE","SI","SK"]);

export async function validateVat(companyId: number, countryCode: string, vat: string, taskId?: number): Promise<{ valid: boolean; name: string | null; address: string | null }> {
  const cc = countryCode.toUpperCase();
  if (!EU.has(cc)) throw new Error(`VIES only covers EU member states, not ${cc}`);
  const number = vat.replace(/^[A-Za-z]{2}/, "").replace(/[\s.-]/g, "");
  const url = `https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${cc}/vat/${number}`;
  const res = await politeFetch(url, { respectRobots: false, taskId, snapshot: { sourceType: "GOVERNMENT_REGISTRY", keepBody: true } });
  const j = JSON.parse(res.body) as { isValid?: boolean; name?: string; address?: string; userError?: string };
  const db = getDb();
  db.run("UPDATE connector_status SET last_attempt_at=?, last_success_at=?, status='CONNECTED' WHERE key='vies'", now(), now());
  if (j.isValid) {
    const name = j.name && j.name !== "---" ? j.name : null;
    const address = j.address && j.address !== "---" ? j.address.replace(/\s*\n\s*/g, ", ") : null;
    const evidence = `VIES: ${cc}${number} isValid=true name=${name ?? "not disclosed"} address=${address ?? "not disclosed"}`;
    recordFact({ entityType: "company", entityId: companyId, field: "vat_number", value: `${cc}${number}`, sourceUrl: url, sourceType: "GOVERNMENT_REGISTRY", factKind: "OFFICIALLY_VERIFIED", evidence, confidence: 0.98, verification: "VERIFIED" });
    db.run("INSERT OR IGNORE INTO company_identifiers (company_id, scheme, value, source_url, verified, verified_at) VALUES (?,?,?,?,1,?)", companyId, "VAT", `${cc}${number}`, url, now());
    if (name) recordFact({ entityType: "company", entityId: companyId, field: "legal_name", value: name, sourceUrl: url, sourceType: "GOVERNMENT_REGISTRY", factKind: "OFFICIALLY_VERIFIED", evidence, confidence: 0.98, verification: "VERIFIED" });
    audit({ actorType: "system", action: "company.vat_validated", entityType: "company", entityId: companyId, summary: evidence });
    return { valid: true, name, address };
  }
  return { valid: false, name: null, address: null };
}
