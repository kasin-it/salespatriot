import { getDb } from "../db/db.ts";
import { politeFetch, setHostInterval } from "../lib/http.ts";
import { iso2 } from "../lib/util.ts";
import type { NormalizedNotice, SyncResult } from "./types.ts";
import { recordConnectorRun, storeNotice } from "../services/procurement-store.ts";

export const TED_ENDPOINT = "https://api.ted.europa.eu/v3/notices/search";
setHostInterval("api.ted.europa.eu", 1500);

export const TED_FIELDS = [
  "publication-number", "notice-type", "notice-title", "title-lot", "description-lot", "buyer-name", "buyer-country",
  "publication-date", "deadline-receipt-tender-date-lot", "classification-cpv", "contract-nature", "legal-basis",
  "procedure-type", "estimated-value-lot", "estimated-value-cur-lot", "winner-name", "winner-country", "tender-value",
  "tender-value-cur", "result-value-notice", "buyer-email", "buyer-internet-address", "links",
];

/** Named TED filters. All use the documented expert-search syntax. */
export const TED_FILTERS: Record<string, { label: string; query: string }> = {
  defence_directive: { label: "Defence directive (2009/81/EC)", query: "legal-basis = 32009L0081" },
  defence_cpv: { label: "Military equipment CPV (35*)", query: "classification-cpv = 35*" },
  electronics: { label: "Electronics & components (31*, 32*)", query: "classification-cpv IN (31* 32*)" },
  optics_security: { label: "Optics & security equipment (386*, 351*)", query: "classification-cpv IN (386* 351*)" },
  aerospace: { label: "Aircraft & aerospace (34.7*, 35.6*)", query: "classification-cpv IN (347* 356*)" },
  agencja_uzbrojenia: { label: "Agencja Uzbrojenia", query: '(buyer-name ~ "Agencja Uzbrojenia" OR buyer-name ~ "Inspektorat Uzbrojenia")' },
  eda: { label: "European Defence Agency", query: 'buyer-name ~ "European Defence Agency"' },
  uav_cpv: { label: "Unmanned aerial vehicles (CPV 35613000)", query: "classification-cpv = 35613000" },
  uav_text: { label: "Text mentions unmanned aerial", query: 'FT ~ "unmanned aerial"' },
  poland: { label: "Buyer in Poland", query: "buyer-country = POL" },
};

type Multi = Record<string, string[] | string | undefined> | undefined;

/** TED multilingual fields: prefer English, then Polish, then first available. */
function pickLang(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.length ? pickLang(v[0]) : null;
  if (typeof v === "object") {
    const o = v as Multi;
    for (const k of ["eng", "pol"]) {
      const x = o?.[k];
      if (x) return Array.isArray(x) ? (x[0] ?? null) : x;
    }
    const first = Object.values(o ?? {})[0];
    return first ? (Array.isArray(first) ? (first[0] ?? null) : first) : null;
  }
  return null;
}

function allLang(v: unknown): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(allLang);
  const o = v as Record<string, unknown>;
  const pref = o.eng ?? o.pol ?? Object.values(o)[0];
  return allLang(pref);
}

const uniq = <T,>(a: T[]): T[] => [...new Set(a)];
const first = <T,>(v: T | T[] | undefined | null): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

export function parseTedNotice(raw: Record<string, unknown>): NormalizedNotice | null {
  const id = raw["publication-number"];
  if (typeof id !== "string") return null;
  const links = raw.links as { html?: Record<string, string> } | undefined;
  const sourceUrl = links?.html?.ENG ?? `https://ted.europa.eu/en/notice/-/detail/${id}`;
  const lotTitles = uniq(allLang(raw["title-lot"]));
  const lotDescriptions = allLang(raw["description-lot"]);
  const cpv = uniq((raw["classification-cpv"] as string[] | undefined) ?? []);
  const deadlines = ((raw["deadline-receipt-tender-date-lot"] as string[] | undefined) ?? []).filter(Boolean).sort();
  const estimated = (raw["estimated-value-lot"] as (string | number)[] | undefined) ?? [];
  const resultValue = raw["result-value-notice"];
  const estSum = estimated.map(Number).filter((n) => Number.isFinite(n)).reduce((a, b) => a + b, 0);
  const currency = first(raw["estimated-value-cur-lot"] as string[] | undefined) ?? first(raw["tender-value-cur"] as string[] | undefined);
  const winners = allLang(raw["winner-name"]);
  const winnerCountries = (raw["winner-country"] as string[] | undefined) ?? [];
  const lots = lotTitles.map((t, i) => ({ title: t, description: lotDescriptions[i] ?? null }));
  const type = (raw["notice-type"] as string | undefined) ?? null;
  const deadlineRaw = deadlines[0] ?? null;
  return {
    sourceKey: "ted",
    retrievedVia: "TED Official API",
    sourceNoticeId: id,
    sourceUrl,
    publicationDate: typeof raw["publication-date"] === "string" ? raw["publication-date"].slice(0, 10) : null,
    originalPayload: raw,
    contractingAuthority: pickLang(raw["buyer-name"]),
    authorityNationalId: null,
    title: pickLang(raw["notice-title"]) ?? lotTitles[0] ?? null,
    description: lotDescriptions.length ? uniq(lotDescriptions).join("\n\n") : null,
    cpvCodes: cpv,
    deadline: deadlineRaw ? deadlineRaw.replace(/\+\d\d:\d\d$/, "") : null,
    estimatedValue: estSum > 0 ? estSum : resultValue != null && Number.isFinite(Number(resultValue)) ? Number(resultValue) : null,
    currency,
    lots,
    technicalRequirements: null,
    noticeType: type,
    procurementStatus: null,
    legalBasis: first(raw["legal-basis"] as string[] | undefined),
    contractNature: first(raw["contract-nature"] as string[] | undefined),
    country: iso2(first(raw["buyer-country"] as string[] | undefined)),
    awardedSuppliers: uniq(winners).map((name) => ({ name, country: iso2(winnerCountries[0] ?? null) })),
  };
}

export interface TedSearchParams {
  filter?: string;
  rawQuery?: string;
  sinceDate?: string; // YYYY-MM-DD
  maxRecords?: number;
  pageSize?: number;
  taskId?: number;
}

export function buildTedQuery(p: TedSearchParams): string {
  const parts: string[] = [];
  const f = p.filter ? TED_FILTERS[p.filter] : undefined;
  if (p.filter && !f) throw new Error(`Unknown TED filter: ${p.filter}`);
  if (f) parts.push(f.query);
  if (p.rawQuery) parts.push(`(${p.rawQuery})`);
  if (p.sinceDate) parts.push(`publication-date >= ${p.sinceDate.replace(/-/g, "")}`);
  if (!parts.length) throw new Error("TED sync requires a filter or a date to avoid an unbounded import");
  return `${parts.join(" AND ")} SORT BY publication-date DESC`;
}

export async function tedSearchPage(query: string, page: number, limit: number, taskId?: number) {
  const res = await politeFetch(TED_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, fields: TED_FIELDS, limit, page, paginationMode: "PAGE_NUMBER", onlyLatestVersions: true }),
    respectRobots: false,
    timeoutMs: 60_000,
    taskId,
  });
  if (res.status !== 200) throw new Error(`TED API returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);
  return JSON.parse(res.body) as { notices: Record<string, unknown>[]; totalNoticeCount: number; timedOut?: boolean };
}

/** Paginates (250/page max) and stores every notice with its original payload. */
export async function syncTed(p: TedSearchParams): Promise<SyncResult> {
  const db = getDb();
  const query = buildTedQuery(p);
  const limit = Math.min(p.pageSize ?? 250, 250);
  const max = p.maxRecords ?? 1000;
  const job = db.insert("ingestion_jobs", { connector_key: "ted", task_id: p.taskId ?? null, status: "RUNNING", params: JSON.stringify({ ...p, query }) });
  const r: SyncResult = { fetched: 0, created: 0, updated: 0, failed: 0, cursor: null };
  let newest: string | null = null;
  try {
    for (let page = 1; r.fetched < max; page++) {
      const data = await tedSearchPage(query, page, limit, p.taskId);
      if (!data.notices?.length) break;
      for (const raw of data.notices) {
        if (r.fetched >= max) break;
        r.fetched++;
        const n = parseTedNotice(raw);
        if (!n) { r.failed++; continue; }
        if (n.publicationDate && (!newest || n.publicationDate > newest)) newest = n.publicationDate;
        try {
          const out = storeNotice(n);
          if (out === "created") r.created++;
          else if (out === "updated") r.updated++;
        } catch { r.failed++; }
      }
      if (data.notices.length < limit || page * limit >= data.totalNoticeCount) break;
    }
    r.cursor = newest;
    db.update("ingestion_jobs", job, { status: "SUCCEEDED", fetched: r.fetched, created: r.created, updated: r.updated, failed: r.failed, finished_at: new Date().toISOString() });
    recordConnectorRun("ted", { ok: true, ...r, cursor: p.filter === undefined && newest ? newest : null });
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.update("ingestion_jobs", job, { status: "FAILED", error: msg, fetched: r.fetched, created: r.created, updated: r.updated, failed: r.failed, finished_at: new Date().toISOString() });
    recordConnectorRun("ted", { ok: false, error: msg, ...r, failed: r.failed + 1 });
    throw e;
  }
}
