import type { MatchStatus } from "@salespatriot/shared";
import { getDb, json } from "../db/db.ts";
import { categoriesForCpv, CATEGORY_BY_KEY } from "../lib/taxonomy.ts";
import { audit } from "../lib/audit.ts";
import { now } from "../lib/util.ts";

interface Demand {
  key: string;
  kind: "NOTICE" | "REQUIREMENT";
  notice?: { id: number; title: string | null; authority: string | null; url: string; cpv: string[]; deadline: string | null; demandClass: string; country: string | null; completeness: number };
  requirement?: { id: number; companyId: number; title: string; cats: string[]; cpv: string[]; certs: string[]; demandClass: string; deliveryLocation: string | null };
  categories: string[];
  cpv: string[];
  demandClass: string;
}

const FRESH_DAYS = 365;

/** Structured filtering first (category + CPV overlap), then a transparent score. Never scores up on missing information. */
export function matchSupplierToDemand(supplierId: number, demand: Demand) {
  const db = getDb();
  const caps = db.all<{ id: number; category_key: string; label: string; capability_class: string; source_url: string | null; evidence_text: string | null; confidence: number; collected_at: string }>(
    "SELECT * FROM company_capabilities WHERE company_id = ?", supplierId);
  const certs = db.all<{ name: string }>("SELECT name FROM company_certifications WHERE company_id = ?", supplierId).map((c) => c.name);
  const overlap = caps.filter((c) => demand.categories.includes(c.category_key));
  if (overlap.length === 0) return null;
  const evidence: unknown[] = [];
  const missing: string[] = [];
  const risks: string[] = [];
  let score = 0;
  const best = overlap.reduce((a, b) => (rank(b.capability_class) > rank(a.capability_class) ? b : a));
  const classScore: Record<string, number> = { VERIFIED_CAPABILITY: 0.5, PUBLICLY_CLAIMED_CAPABILITY: 0.3, INFERRED_CAPABILITY: 0.15, UNVERIFIED_CAPABILITY: 0.1 };
  score += classScore[best.capability_class] ?? 0.1;
  score += Math.min(0.15, 0.05 * (overlap.length - 1));
  for (const o of overlap) evidence.push({ type: "capability", label: o.label, class: o.capability_class, sourceUrl: o.source_url, passage: o.evidence_text, collectedAt: o.collected_at });
  if (demand.notice) {
    evidence.push({ type: "procurement_notice", id: demand.notice.id, sourceUrl: demand.notice.url, title: demand.notice.title, authority: demand.notice.authority });
    const cpvHit = categoriesForCpv(demand.notice.cpv).filter((c) => overlap.some((o) => o.category_key === c));
    if (cpvHit.length) score += 0.15;
    if (demand.demandClass === "CONFIRMED_DEMAND") score += 0.1;
    else risks.push("Notice is not current demand (awarded/closed or historical).");
    if (!demand.notice.deadline) missing.push("Submission deadline not published in the notice");
    if (demand.notice.completeness < 0.6) missing.push("Notice metadata is incomplete; requirements may need to be read in the original document");
    missing.push("Technical specification details must be read in the original notice", "Eligibility (security clearance, export control, local-presence rules) not assessed");
    risks.push("Eligibility for this procurement has NOT been checked; a public profile does not establish eligibility.");
  }
  if (demand.requirement) {
    const req = demand.requirement;
    const needed = req.certs.filter((c) => !certs.includes(c));
    if (req.certs.length && needed.length === 0) score += 0.15;
    else if (needed.length) { missing.push(`Required certification(s) not found for supplier: ${needed.join(", ")}`); risks.push("Certification requirement not evidenced"); }
    if (demand.demandClass === "USER_PROVIDED_DEMAND") score += 0.1;
  }
  const newest = Math.max(...overlap.map((c) => Date.parse(c.collected_at)));
  if (Date.now() - newest > FRESH_DAYS * 86400_000) { score -= 0.1; risks.push("Supplier evidence older than 12 months"); }
  missing.push("Stock, production capacity, pricing and lead time are unknown unless supplied by the supplier");
  if (best.capability_class !== "VERIFIED_CAPABILITY") risks.push("Capability is a public company claim, not verified by the company or a third party");
  // Insufficient information caps the score; an inferred-only or unverified capability can never reach a high score.
  const capped = best.capability_class === "VERIFIED_CAPABILITY" ? 1 : best.capability_class === "PUBLICLY_CLAIMED_CAPABILITY" ? 0.7 : 0.4;
  score = Math.max(0, Math.min(score, capped));
  let status: MatchStatus = "POTENTIAL_MATCH";
  if (best.capability_class === "VERIFIED_CAPABILITY" && score >= 0.7 && demand.demandClass !== "HISTORICAL_DEMAND" && !missing.some((m) => m.startsWith("Required certification"))) status = "VERIFIED_MATCH";
  else if (best.capability_class === "INFERRED_CAPABILITY" || best.capability_class === "UNVERIFIED_CAPABILITY" || score < 0.3) status = "INSUFFICIENT_INFORMATION";
  const labels = overlap.map((o) => CATEGORY_BY_KEY.get(o.category_key)?.label ?? o.category_key);
  const explanation = demand.notice
    ? `${labels.join(", ")} appear in this supplier's ${best.capability_class === "VERIFIED_CAPABILITY" ? "verified" : "publicly claimed"} capabilities and match the notice's category (${demand.notice.authority ?? "unknown authority"}: "${demand.notice.title ?? "untitled"}"). This is a ${demand.demandClass === "CONFIRMED_DEMAND" ? "published procurement" : "historical notice"}, not an invitation to Arsenal AI users.`
    : `${labels.join(", ")} appear in the supplier's capabilities and match the buyer requirement "${demand.requirement?.title}".`;
  return { score: Math.round(score * 100) / 100, status, evidence, missing, risks, explanation, categories: overlap.map((o) => o.category_key), confidence: Math.round(Math.min(best.confidence, score + 0.1) * 100) / 100 };
}

const rank = (c: string) => ({ VERIFIED_CAPABILITY: 4, PUBLICLY_CLAIMED_CAPABILITY: 3, INFERRED_CAPABILITY: 2, UNVERIFIED_CAPABILITY: 1 })[c] ?? 0;

/** Create/refresh matches between a supplier and all open notices + buyer requirements. */
export function runMatchingForSupplier(supplierId: number, originEventId: number | null = null): number {
  const db = getDb();
  let n = 0;
  const notices = db.all<{ id: number; title: string | null; contracting_authority: string | null; source_url: string; cpv_codes: string; deadline: string | null; demand_class: string; country: string | null; data_completeness: number; notice_type: string | null }>(
    "SELECT id,title,contracting_authority,source_url,cpv_codes,deadline,demand_class,country,data_completeness,notice_type FROM procurement_notices WHERE demand_class = 'CONFIRMED_DEMAND' AND (deadline IS NULL OR deadline > ?) ORDER BY publication_date DESC LIMIT 2000", now());
  for (const nt of notices) {
    const cpv = json<string[]>(nt.cpv_codes, []);
    const cats = categoriesForCpv(cpv);
    if (cats.length === 0) continue;
    const m = matchSupplierToDemand(supplierId, { key: `n${nt.id}`, kind: "NOTICE", categories: cats, cpv, demandClass: nt.demand_class, notice: { id: nt.id, title: nt.title, authority: nt.contracting_authority, url: nt.source_url, cpv, deadline: nt.deadline, demandClass: nt.demand_class, country: nt.country, completeness: nt.data_completeness } });
    if (m) { saveMatch(`notice:${nt.id}:supplier:${supplierId}`, "NOTICE_SUPPLIER", m, { supplierId, noticeId: nt.id, demandClass: nt.demand_class, eventId: originEventId }); n++; }
  }
  const reqs = db.all<{ id: number; company_id: number; title: string; category_keys: string; cpv_codes: string; certifications_required: string; demand_class: string; delivery_location: string | null }>("SELECT * FROM buyer_requirements WHERE status='OPEN' AND company_id != ?", supplierId);
  for (const r of reqs) {
    const cats = [...new Set([...json<string[]>(r.category_keys, []), ...categoriesForCpv(json<string[]>(r.cpv_codes, []))])];
    if (!cats.length) continue;
    const m = matchSupplierToDemand(supplierId, { key: `r${r.id}`, kind: "REQUIREMENT", categories: cats, cpv: [], demandClass: r.demand_class, requirement: { id: r.id, companyId: r.company_id, title: r.title, cats, cpv: [], certs: json<string[]>(r.certifications_required, []), demandClass: r.demand_class, deliveryLocation: r.delivery_location } });
    if (m) { saveMatch(`req:${r.id}:supplier:${supplierId}`, "REQUIREMENT_SUPPLIER", m, { supplierId, buyerId: r.company_id, requirementId: r.id, demandClass: r.demand_class, eventId: originEventId, visibleTo: r.company_id }); n++; }
  }
  return n;
}

function saveMatch(key: string, kind: string, m: NonNullable<ReturnType<typeof matchSupplierToDemand>>, o: { supplierId: number; noticeId?: number; buyerId?: number; requirementId?: number; demandClass: string; eventId: number | null; visibleTo?: number }): void {
  const db = getDb();
  const existing = db.get<{ id: number }>("SELECT id FROM matches WHERE match_key = ?", key);
  const row = { score: m.score, status: m.status, explanation: m.explanation, evidence: JSON.stringify(m.evidence), missing_info: JSON.stringify(m.missing), risks: JSON.stringify(m.risks), confidence: m.confidence, category_keys: JSON.stringify(m.categories), updated_at: now() };
  if (existing) { db.update("matches", existing.id, row); return; }
  const id = db.insert("matches", { ...row, kind, match_key: key, supplier_company_id: o.supplierId, procurement_notice_id: o.noticeId ?? null, buyer_company_id: o.buyerId ?? null, buyer_requirement_id: o.requirementId ?? null, origin_event_id: o.eventId, demand_class: o.demandClass, visible_to_company_id: o.visibleTo ?? null });
  audit({ actorType: "agent", actorId: "matching", action: "match.created", entityType: "match", entityId: id, summary: `${m.status} (${m.score}) ${kind}` });
}
