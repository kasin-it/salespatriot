import { getDb, json } from "../db/db.ts";
import { categoriesForCpv, CATEGORY_BY_KEY } from "../lib/taxonomy.ts";
import { resolveCompany } from "./companies.ts";
import { audit } from "../lib/audit.ts";

/**
 * Supplier Intelligence from official award notices: a company named as winner in a published TED / BZP award notice has
 * demonstrated supply in that CPV category. This is government-published; it does not imply stock, capacity or current availability.
 */
export function deriveSuppliersFromAwards(limit = 500): { companies: number; capabilities: number } {
  const db = getDb();
  const rows = db.all<{ id: number; source_url: string; awarded_suppliers: string; cpv_codes: string; title: string | null; publication_date: string | null; contracting_authority: string | null }>(
    "SELECT id, source_url, awarded_suppliers, cpv_codes, title, publication_date, contracting_authority FROM procurement_notices WHERE awarded_suppliers != '[]' ORDER BY publication_date DESC LIMIT ?", limit);
  let companies = 0, caps = 0;
  for (const n of rows) {
    const cats = categoriesForCpv(json<string[]>(n.cpv_codes, []));
    if (!cats.length) continue;
    for (const w of json<{ name: string; country: string | null }[]>(n.awarded_suppliers, [])) {
      const r = resolveCompany({ name: w.name, country: w.country, origin: "award_notice", sourceUrl: n.source_url, sourceType: "PROCUREMENT_PORTAL", factKind: "GOVERNMENT_PUBLISHED", evidence: `Named as awardee in notice ${n.source_url}` });
      if (r.created) companies++;
      for (const k of cats) {
        const ev = `Awarded contract "${n.title ?? "untitled"}" by ${n.contracting_authority ?? "unknown authority"} (published ${n.publication_date ?? "n/a"}) in category ${CATEGORY_BY_KEY.get(k)?.label}; CPV ${json<string[]>(n.cpv_codes, []).join(", ")}`;
        const x = db.run("INSERT OR IGNORE INTO company_capabilities (company_id, category_key, label, capability_class, source_url, source_type, evidence_text, confidence, verification_status) VALUES (?,?,?,?,?,?,?,?,?)",
          r.companyId, k, CATEGORY_BY_KEY.get(k)?.label ?? k, "VERIFIED_CAPABILITY", n.source_url, "PROCUREMENT_PORTAL", ev, 0.8, "VERIFIED");
        caps += x.changes;
      }
    }
  }
  if (caps) audit({ actorType: "agent", actorId: "supplier_intelligence", action: "supplier.capabilities_derived", summary: `${caps} award-based capabilities, ${companies} new companies` });
  return { companies, capabilities: caps };
}
