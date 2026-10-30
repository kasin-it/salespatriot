import { getDb, json } from "../db/db.ts";
import { categoriesForCpv, classifyText } from "../lib/taxonomy.ts";
import { now } from "../lib/util.ts";

export interface DemandNotice {
  id: number; title: string | null; authority: string | null; country: string | null; url: string; deadline: string | null; publicationDate: string | null;
  noticeType: string | null; demandClass: string; value: number | null; currency: string | null; via: "CPV" | "TEXT"; specific: boolean; inTitle: boolean;
}
export interface DemandReport { open: DemandNotice[]; awards: DemandNotice[]; totals: { open: number; awards: number } }

/** Real procurement notices for a product category: by official CPV code or by category terms found in the notice's own title/description. */
export function demandForCategory(key: string, opts: { specific?: string[]; limit?: number } = {}): DemandReport {
  const limit = opts.limit ?? 5;
  const specific = opts.specific ?? [];
  const rows = getDb().all<{ id: number; title: string | null; description: string | null; contracting_authority: string | null; country: string | null; source_url: string; deadline: string | null; publication_date: string | null; demand_class: string; notice_type: string | null; estimated_value: number | null; currency: string | null; cpv_codes: string }>(
    "SELECT id, title, substr(description,1,1500) description, contracting_authority, country, source_url, deadline, publication_date, demand_class, notice_type, estimated_value, currency, cpv_codes FROM procurement_notices ORDER BY publication_date DESC LIMIT 8000");
  const out: DemandNotice[] = [];
  for (const r of rows) {
    const byCpv = categoriesForCpv(json<string[]>(r.cpv_codes, [])).includes(key);
    const text = `${r.title ?? ""} ${r.description ?? ""}`;
    const byText = !byCpv && classifyText(text).some((h) => h.key === key);
    if (!byCpv && !byText) continue;
    const lower = text.toLowerCase();
    out.push({ id: r.id, title: r.title, authority: r.contracting_authority, country: r.country, url: r.source_url, deadline: r.deadline, publicationDate: r.publication_date, noticeType: r.notice_type, demandClass: r.demand_class, value: r.estimated_value, currency: r.currency, via: byCpv ? "CPV" : "TEXT", specific: specific.some((t) => lower.includes(t)), inTitle: classifyText(r.title ?? "").some((h) => h.key === key) });
  }
  // The notice's own title naming the product ("Unmanned aerial vehicles – …") beats a CPV code listed among many, which beats a text mention.
  const rank = (a: DemandNotice, b: DemandNotice) => Number(b.inTitle) - Number(a.inTitle) || Number(b.via === "CPV") - Number(a.via === "CPV") || Number(b.specific) - Number(a.specific) || (b.publicationDate ?? "").localeCompare(a.publicationDate ?? "");
  const isOpen = (n: DemandNotice) => n.demandClass === "CONFIRMED_DEMAND" && (!n.deadline || n.deadline > now());
  const open = out.filter(isOpen).sort(rank);
  const awards = out.filter((n) => !isOpen(n)).sort(rank);
  return { open: open.slice(0, limit), awards: awards.slice(0, limit), totals: { open: open.length, awards: awards.length } };
}
