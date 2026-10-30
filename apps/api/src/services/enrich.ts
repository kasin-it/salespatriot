import { parseHTML } from "linkedom";
import { getDb } from "../db/db.ts";
import { politeFetch } from "../lib/http.ts";
import { cleanText, domainOf, excerpt, now } from "../lib/util.ts";
import { CERTIFICATION_PATTERNS, classifyText } from "../lib/taxonomy.ts";
import { recordFact, upsertSource } from "../lib/provenance.ts";
import { indexCompany } from "./companies.ts";
import { audit } from "../lib/audit.ts";

const PAGE_HINT = /(product|solution|offer|portfolio|capabilit|service|about|company|oferta|produkt|uslug|o-nas|o-firmie|unternehmen|produkte|leistung|certif|quality|jakosc|contact|kontakt)/i;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export interface EnrichmentResult {
  pagesFetched: number;
  capabilities: number;
  certifications: number;
  contacts: number;
  products: number;
  errors: string[];
}

/**
 * Enrich a company from its OFFICIAL website only. Pure extraction: categories come from taxonomy terms found in the page text
 * (the matching passage is stored as evidence), certifications from explicit mentions, contacts from public mailto:/tel: links.
 * Everything is a company-published claim and stays UNVERIFIED until the company confirms it. Page text is data, never instructions.
 */
export async function enrichCompanyFromWebsite(companyId: number, taskId?: number, maxPages = 6): Promise<EnrichmentResult> {
  const db = getDb();
  const c = db.get<{ website: string | null; canonical_name: string }>("SELECT website, canonical_name FROM companies WHERE id = ?", companyId);
  const res: EnrichmentResult = { pagesFetched: 0, capabilities: 0, certifications: 0, contacts: 0, products: 0, errors: [] };
  if (!c?.website) {
    db.update("companies", companyId, { enrichment_status: "NO_WEBSITE", last_enriched_at: now() });
    return res;
  }
  db.update("companies", companyId, { enrichment_status: "RUNNING" });
  const home = c.website;
  const host = domainOf(home);
  const queue: string[] = [home];
  const seen = new Set<string>();
  while (queue.length && res.pagesFetched < maxPages) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    let page;
    try {
      page = await politeFetch(url, { taskId, retries: 1, timeoutMs: 20_000, maxBytes: 3_000_000, snapshot: { sourceType: "OFFICIAL_COMPANY_WEBSITE", keepBody: false } });
    } catch (e) {
      res.errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      if (res.pagesFetched === 0 && url === home) break;
      continue;
    }
    if (page.status !== 200 || !/html/i.test(page.contentType)) { res.errors.push(`${url}: HTTP ${page.status} ${page.contentType}`); continue; }
    res.pagesFetched++;
    let document: ReturnType<typeof parseHTML>["document"];
    try {
      document = parseHTML(page.body).document;
      if (!document.documentElement) throw new Error("empty document");
    } catch (e) {
      res.errors.push(`${url}: unparseable HTML (${e instanceof Error ? e.message : String(e)})`);
      continue;
    }
    const links = [...document.querySelectorAll("a[href]")].flatMap((a) => {
      try {
        const u = new URL(a.getAttribute("href")!, page.finalUrl);
        return [{ u, text: cleanText(a.textContent) ?? "" }];
      } catch { return []; }
    });
    // Public contacts from mailto:/tel: links (explicitly published by the company).
    for (const { u } of links) {
      if (u.protocol === "mailto:") {
        const email = decodeURIComponent(u.pathname).toLowerCase().trim();
        if (/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) {
          const r = db.run("INSERT OR IGNORE INTO company_contacts (company_id, kind, value, source_url, evidence_text) VALUES (?, 'email', ?, ?, ?)", companyId, email, url, `mailto link on ${url}`);
          res.contacts += r.changes;
        }
      } else if (u.protocol === "tel:") {
        const tel = decodeURIComponent(u.pathname).trim();
        const r = db.run("INSERT OR IGNORE INTO company_contacts (company_id, kind, value, source_url, evidence_text) VALUES (?, 'phone', ?, ?, ?)", companyId, tel, url, `tel link on ${url}`);
        res.contacts += r.changes;
      }
    }
    // Queue likely informative same-site pages.
    for (const { u, text } of links) {
      if (!/^https?:$/.test(u.protocol) || domainOf(u.toString()) !== host) continue;
      u.hash = "";
      if (PAGE_HINT.test(u.pathname) || PAGE_HINT.test(text)) queue.push(u.toString());
    }
    const metaDesc = cleanText(document.querySelector('meta[name="description"]')?.getAttribute("content") ?? document.querySelector('meta[property="og:description"]')?.getAttribute("content") ?? null);
    if (metaDesc && url === home) {
      db.update("companies", companyId, { description: metaDesc, description_source_url: url });
      recordFact({ entityType: "company", entityId: companyId, field: "description", value: metaDesc, sourceUrl: url, sourceType: "OFFICIAL_COMPANY_WEBSITE", factKind: "COMPANY_PUBLISHED", evidence: metaDesc, confidence: 0.8 });
    }
    // Product candidates: headings on product-like pages.
    const productPage = /(product|solution|offer|portfolio|produkt|oferta)/i.test(new URL(page.finalUrl).pathname);
    const headings = productPage ? [...document.querySelectorAll("h2,h3")].map((h) => cleanText(h.textContent)).filter((t): t is string => !!t && t.length >= 3 && t.length <= 70 && !/(cookie|newsletter|contact|follow|menu|subscribe|privacy)/i.test(t)) : [];
    for (const h of headings.slice(0, 25)) {
      const r = db.run("INSERT OR IGNORE INTO company_products (company_id, name, source_url, source_type, fact_kind, evidence_text, confidence) VALUES (?,?,?,?,?,?,?)", companyId, h, url, "OFFICIAL_COMPANY_WEBSITE", "COMPANY_PUBLISHED", `Heading on product page ${url}`, 0.5);
      res.products += r.changes;
    }
    document.querySelectorAll("script,style,noscript,nav,footer").forEach((n: { remove(): void }) => n.remove());
    const text = cleanText(document.body?.textContent ?? "") ?? "";
    for (const hit of classifyText(text)) {
      const r = db.run("INSERT OR IGNORE INTO company_capabilities (company_id, category_key, label, capability_class, source_url, source_type, evidence_text, confidence) VALUES (?,?,?,?,?,?,?,?)",
        companyId, hit.key, hit.label, "PUBLICLY_CLAIMED_CAPABILITY", url, "OFFICIAL_COMPANY_WEBSITE", excerpt(text, hit.index), 0.55);
      res.capabilities += r.changes;
    }
    for (const cert of CERTIFICATION_PATTERNS) {
      const m = cert.re.exec(text);
      if (m) {
        const r = db.run("INSERT OR IGNORE INTO company_certifications (company_id, name, fact_kind, source_url, evidence_text, confidence) VALUES (?,?,?,?,?,?)", companyId, cert.name, "COMPANY_PUBLISHED", url, excerpt(text, m.index), 0.6);
        res.certifications += r.changes;
      }
    }
    void EMAIL_RE;
  }
  if (res.pagesFetched > 0) upsertSource(home, "OFFICIAL_COMPANY_WEBSITE");
  db.update("companies", companyId, { enrichment_status: res.pagesFetched > 0 ? "COMPLETED" : "FAILED", last_enriched_at: now() });
  indexCompany(companyId);
  audit({ actorType: "agent", actorId: "company_discovery", action: "company.enriched", entityType: "company", entityId: companyId, summary: `Enriched "${c.canonical_name}": ${res.pagesFetched} pages, ${res.capabilities} capability claims, ${res.certifications} certification mentions, ${res.contacts} public contacts${res.errors.length ? `, ${res.errors.length} errors` : ""}`, detail: res });
  return res;
}
