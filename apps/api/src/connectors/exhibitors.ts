import { parseHTML } from "linkedom";
import { politeFetch } from "../lib/http.ts";
import { cleanText, countryFromName, normalizeUrl } from "../lib/util.ts";

export interface ExhibitorRecord {
  externalId: string | null;
  name: string;
  /** True when the name was derived from a URL slug only and the profile page has not been read yet. */
  stub: boolean;
  country: string | null;
  city: string | null;
  website: string | null;
  booth: string | null;
  description: string | null;
  categories: string[];
  profileUrl: string | null;
  sourceUrl: string;
  evidence: string;
}

export interface ExtractorContext {
  eventUrl: string;
  taskId?: number;
  maxList?: number;
  /** Extractors report the concrete directory URL they resolved (e.g. the latest edition). */
  setDirectoryUrl?: (url: string) => void;
}

export interface Extractor {
  key: string;
  label: string;
  matches(eventUrl: string): boolean;
  directoryUrl(eventUrl: string): string;
  list(ctx: ExtractorContext): Promise<ExhibitorRecord[]>;
  detail?(rec: ExhibitorRecord, ctx: ExtractorContext): Promise<ExhibitorRecord>;
}

const doc = (html: string) => parseHTML(html).document;
const text = (el: { textContent: string | null } | null | undefined) => cleanText(el?.textContent ?? null);

const humanizeSlug = (slug: string) => slug.replace(/-/g, " ").replace(/\s+/g, " ").trim().toUpperCase();

// ---- MSPO / Targi Kielce -------------------------------------------------------------
const KIELCE_SITEMAP = "https://www.targikielce.pl/en_event-exhibitor-cards_sitemap.xml";

/** Public sitemap URLs for one Kielce fair: /en/mspo-2026/list-of-exhibitors/<slug>,<id> */
export function parseKielceSitemap(xml: string, fairSlug: string): { id: string; slug: string; url: string }[] {
  const re = new RegExp(`<loc>(https://www\\.targikielce\\.pl/en/${fairSlug}/list-of-exhibitors/([^,<]+),(\\d+))</loc>`, "g");
  const out = new Map<string, { id: string; slug: string; url: string }>();
  for (const m of xml.matchAll(re)) out.set(m[3]!, { id: m[3]!, slug: m[2]!, url: m[1]! });
  return [...out.values()];
}

export function parseKielceDetail(html: string, url: string, id: string): ExhibitorRecord | null {
  const d = doc(html);
  const name = text(d.querySelector("h1.page-header"));
  if (!name) return null;
  const strongs = d.querySelectorAll(".exhibitors-details__info li");
  let address: string | null = null;
  let website: string | null = null;
  for (const li of strongs) {
    if (li.querySelector(".icon-map-marker")) address = text(li.querySelector("strong"));
    if (li.classList.contains("exhibitors-details__info-links")) {
      const a = li.querySelector("a[href]");
      const href = a?.getAttribute("href");
      if (href && /^https?:/.test(href) && !/targikielce\.pl/.test(href)) website = normalizeUrl(href);
    }
  }
  const lastPart = address?.split(",").pop()?.trim() ?? null;
  const country = countryFromName(lastPart);
  return {
    externalId: id, name, stub: false, country, city: null, website, booth: null, description: null, categories: [],
    profileUrl: url, sourceUrl: url,
    evidence: `Exhibitor profile page: h1="${name}"${address ? `, address="${address}"` : ""}${website ? `, website link=${website}` : ""}`,
  };
}

export function parseKielceListRows(html: string, fairSlug: string): { name: string; country: string | null; booth: string | null; id: string; url: string }[] {
  const d = doc(html);
  const out: { name: string; country: string | null; booth: string | null; id: string; url: string }[] = [];
  for (const tr of d.querySelectorAll("tbody tr")) {
    const a = tr.querySelector("div.main-title a");
    const href = a?.getAttribute("href") ?? "";
    const m = new RegExp(`/${fairSlug}/list-of-exhibitors/[^,]+,(\\d+)$`).exec(href);
    const name = text(a);
    if (!m || !name) continue;
    const country = text(tr.querySelectorAll("td div.hide-for-representatives")[1] ?? null);
    out.push({ name, country, booth: text(tr.querySelector(".main-stands")), id: m[1]!, url: href });
  }
  return out;
}

const kielce: Extractor = {
  key: "kielce",
  label: "Targi Kielce exhibitor cards (public sitemap + profile pages)",
  matches: (u) => /targikielce\.pl\/(en|pl)\/[a-z0-9-]+/i.test(u),
  directoryUrl: (u) => {
    const slug = /targikielce\.pl\/(?:en|pl)\/([a-z0-9-]+?)(?:\/|$)/i.exec(u)?.[1] ?? "mspo-2026";
    return `https://www.targikielce.pl/en/${slug}/list-of-exhibitors`;
  },
  async list(ctx) {
    const given = /targikielce\.pl\/(?:en|pl)\/([a-z0-9-]+?)(?:\/|$)/i.exec(ctx.eventUrl)?.[1] ?? "mspo-2026";
    const res = await politeFetch(KIELCE_SITEMAP, { taskId: ctx.taskId, cacheTtlMs: 6 * 3600_000, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE", keepBody: false }, timeoutMs: 60_000 });
    // An evergreen page such as /en/mspo maps to the newest "<fair>-<year>" edition that has published exhibitor cards.
    const base = given.replace(/-\d{4}$/, "");
    const editions = [...new Set([...res.body.matchAll(new RegExp(`/en/(${base}(?:-\\d{4})?)/list-of-exhibitors/`, "g"))].map((m) => m[1]!))].sort();
    const slug = given !== base ? given : (editions.at(-1) ?? given);
    const dir = `https://www.targikielce.pl/en/${slug}/list-of-exhibitors`;
    ctx.setDirectoryUrl?.(dir);
    let entries = parseKielceSitemap(res.body, slug);
    // Fall back to HTML rows (first server-rendered page) if the sitemap holds nothing for this fair.
    if (entries.length === 0) {
      const page = await politeFetch(dir, { taskId: ctx.taskId });
      return parseKielceListRows(page.body, slug).map((r) => ({
        externalId: r.id, name: r.name, stub: false, country: countryFromName(r.country), city: null, website: null, booth: r.booth, description: null,
        categories: [], profileUrl: r.url, sourceUrl: dir, evidence: `Row in official exhibitor list ${dir}: "${r.name}", ${r.country ?? "country n/a"}, stand ${r.booth ?? "n/a"}`,
      }));
    }
    if (ctx.maxList) entries = entries.slice(0, ctx.maxList);
    return entries.map((e) => ({
      externalId: e.id, name: humanizeSlug(e.slug), stub: true, country: null, city: null, website: null, booth: null, description: null,
      categories: [], profileUrl: e.url, sourceUrl: KIELCE_SITEMAP,
      evidence: `Listed in official sitemap ${KIELCE_SITEMAP}: ${e.url} (name taken from URL slug until the profile page is read)`,
    }));
  },
  async detail(rec, ctx) {
    if (!rec.profileUrl || !rec.externalId) return rec;
    const res = await politeFetch(rec.profileUrl, { taskId: ctx.taskId, cacheTtlMs: 24 * 3600_000, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE", keepBody: false } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${rec.profileUrl}`);
    return parseKielceDetail(res.body, rec.profileUrl, rec.externalId) ?? rec;
  },
};

// ---- Enforce Tac / NürnbergMesse --------------------------------------------------------
export function parseEnforceSitemap(xml: string): { id: string; url: string; slug: string }[] {
  const out: { id: string; url: string; slug: string }[] = [];
  for (const m of xml.matchAll(/<loc>(https:\/\/www\.enforcetac\.com\/en\/exhibitors\/([^/<]+)-(\d+))<\/loc>/g)) out.push({ url: m[1]!, slug: m[2]!, id: m[3]! });
  return out;
}

export function parseEnforceDetail(html: string, url: string): ExhibitorRecord | null {
  const m = /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let c: Record<string, unknown> | undefined;
  try {
    c = (JSON.parse(m[1]!) as { props?: { pageProps?: { companyData?: Record<string, unknown> } } }).props?.pageProps?.companyData;
  } catch {
    return null;
  }
  const name = typeof c?.companyprofilename === "string" ? cleanText(c.companyprofilename) : null;
  if (!c || !name) return null;
  const booths = Array.isArray(c.booth) ? (c.booth as { boothnumber?: string }[]).map((b) => b.boothnumber).filter(Boolean) : [];
  const noms = Array.isArray(c.nomenclatures) ? (c.nomenclatures as { nomenclaturedisplay?: string }[]).map((n) => n.nomenclaturedisplay).filter((x): x is string => !!x) : [];
  const descHtml = typeof c.companydescription === "string" ? c.companydescription : null;
  const description = descHtml ? cleanText(doc(`<div>${descHtml}</div>`).body?.textContent ?? null) : null;
  const str = (v: unknown) => (typeof v === "string" && v !== "None" ? cleanText(v) : null);
  return {
    externalId: str(c.id), name, stub: false, country: countryFromName(str(c.country)) ?? str(c.country), city: str(c.city),
    website: normalizeUrl(str(c.url)), booth: booths.join(", ") || null, description, categories: noms, profileUrl: url, sourceUrl: url,
    evidence: `Exhibitor profile ${url}: companyprofilename="${name}", country=${str(c.country) ?? "n/a"}, url=${str(c.url) ?? "n/a"}, edition=${str(c.productnuemeverid) ?? "n/a"}`,
  };
}

const enforce: Extractor = {
  key: "enforcetac",
  label: "Enforce Tac exhibitor profiles (public sitemap + embedded page data)",
  matches: (u) => /enforcetac\.com/i.test(u),
  directoryUrl: () => "https://www.enforcetac.com/en/exhibitors-products/find-exhibitors",
  async list(ctx) {
    const res = await politeFetch("https://www.enforcetac.com/sitemap.xml", { taskId: ctx.taskId, cacheTtlMs: 6 * 3600_000, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE", keepBody: false }, timeoutMs: 60_000 });
    let entries = parseEnforceSitemap(res.body);
    if (ctx.maxList) entries = entries.slice(0, ctx.maxList);
    return entries.map((e) => ({
      externalId: e.id, name: humanizeSlug(e.slug), stub: true, country: null, city: null, website: null, booth: null, description: null,
      categories: [], profileUrl: e.url, sourceUrl: "https://www.enforcetac.com/sitemap.xml",
      evidence: `Listed in official sitemap https://www.enforcetac.com/sitemap.xml: ${e.url} (name taken from URL slug until the profile page is read)`,
    }));
  },
  async detail(rec, ctx) {
    if (!rec.profileUrl) return rec;
    const res = await politeFetch(rec.profileUrl, { taskId: ctx.taskId, cacheTtlMs: 24 * 3600_000, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE", keepBody: false } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${rec.profileUrl}`);
    return parseEnforceDetail(res.body, rec.profileUrl) ?? rec;
  },
};

// ---- DSEI / asp.events platform -----------------------------------------------------------
export function parseDseiList(html: string, pageUrl: string): ExhibitorRecord[] {
  const d = doc(html);
  const out: ExhibitorRecord[] = [];
  for (const li of d.querySelectorAll("li.m-exhibitors-list__items__item")) {
    const a = li.querySelector(".m-exhibitors-list__items__item__header__title__link");
    const name = text(a);
    const slug = /openRemoteModal\('exhibitors-list\/([^']+)'/.exec(a?.getAttribute("href") ?? "")?.[1];
    if (!name) continue;
    const stand = text(li.querySelector(".m-exhibitors-list__items__item__header__meta__stand"))?.replace(/^Stand:\s*/i, "") ?? null;
    const origin = new URL(pageUrl).origin;
    out.push({
      externalId: li.getAttribute("data-content-i-d"), name, stub: false, country: null, city: null, website: null, booth: stand || null, description: null, categories: [],
      profileUrl: slug ? `${origin}/exhibitors-list/${slug}` : null, sourceUrl: pageUrl,
      evidence: `Row in official exhibitor list ${pageUrl}: "${name}"${stand ? `, stand ${stand}` : ""}`,
    });
  }
  return out;
}

export function parseDseiDetail(html: string, url: string, base: ExhibitorRecord): ExhibitorRecord {
  const d = doc(html);
  const name = text(d.querySelector("h1.m-exhibitor-entry__item__header__title")) ?? base.name;
  const categories = [...d.querySelectorAll(".m-exhibitor-entry__item__header__categories__item")].map((e) => text(e)).filter((x): x is string => !!x);
  const description = text(d.querySelector(".m-exhibitor-entry__item__body__description"));
  const site = d.querySelector(".m-exhibitor-entry__item__body__contacts__additional__website a")?.getAttribute("href");
  return { ...base, name, stub: false, description, categories, website: normalizeUrl(site), profileUrl: url, evidence: `${base.evidence}; profile ${url}${site ? ` lists website ${site}` : ""}` };
}

const dsei: Extractor = {
  key: "dsei",
  label: "DSEI exhibitor list (asp.events, paginated HTML)",
  matches: (u) => /dsei\.co\.uk/i.test(u),
  directoryUrl: () => "https://www.dsei.co.uk/visit/exhibiting-companies",
  async list(ctx) {
    const base = "https://www.dsei.co.uk/visit/exhibiting-companies";
    const all: ExhibitorRecord[] = [];
    for (let page = 1; page <= 12; page++) {
      const url = `${base}?page=${page}`;
      const res = await politeFetch(url, { taskId: ctx.taskId, cacheTtlMs: 6 * 3600_000, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE", keepBody: false } });
      const rows = parseDseiList(res.body, url);
      if (rows.length === 0) break;
      all.push(...rows);
      if (ctx.maxList && all.length >= ctx.maxList) break;
    }
    return ctx.maxList ? all.slice(0, ctx.maxList) : all;
  },
  async detail(rec, ctx) {
    if (!rec.profileUrl) return rec;
    const res = await politeFetch(rec.profileUrl, { taskId: ctx.taskId, cacheTtlMs: 24 * 3600_000, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE", keepBody: false } });
    if (res.status !== 200) throw new Error(`HTTP ${res.status} for ${rec.profileUrl}`);
    return parseDseiDetail(res.body, rec.profileUrl, rec);
  },
};

export const EXTRACTORS: Extractor[] = [kielce, enforce, dsei];
export const extractorFor = (eventUrl: string): Extractor | undefined => EXTRACTORS.find((e) => e.matches(eventUrl));
