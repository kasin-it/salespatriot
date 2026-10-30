import { getDb } from "../db/db.ts";
import { politeFetch, setHostInterval } from "../lib/http.ts";
import { cleanText } from "../lib/util.ts";
import { parseHTML } from "linkedom";
import type { NormalizedNotice, SyncResult } from "./types.ts";
import { recordConnectorRun, storeNotice } from "../services/procurement-store.ts";

export const EZ_ENDPOINT = "https://ezamowienia.gov.pl/mo-board/api/v1/notice";
// 30 requests/minute documented limit -> one request per 2.1 s keeps a safe margin.
setHostInterval("ezamowienia.gov.pl", 2100);

export const EZ_NOTICE_TYPES = ["ContractNotice", "TenderResultNotice", "NoticeUpdateNotice", "CompetitionNotice", "ContractAwardNotice"] as const;

interface EzRaw {
  noticeType?: string;
  noticeNumber?: string;
  bzpNumber?: string;
  publicationDate?: string;
  orderObject?: string;
  orderType?: string;
  cpvCode?: string | null;
  submittingOffersDate?: string | null;
  procedureResult?: string | null;
  organizationName?: string;
  organizationCity?: string;
  organizationCountry?: string;
  organizationNationalId?: string;
  tenderId?: string;
  objectId?: string;
  htmlBody?: string;
  contractors?: { contractorName?: string; contractorCountry?: string; contractorNationalId?: string }[] | null;
  isTenderAmountBelowEU?: boolean;
}

function parseCpv(s: string | null | undefined): string[] {
  if (!s) return [];
  return [...new Set([...s.matchAll(/\b(\d{8})-\d\b/g)].map((m) => m[1]!))];
}

export function parseEzNotice(raw: EzRaw): NormalizedNotice | null {
  if (!raw.noticeNumber || !raw.objectId) return null;
  // Keep the original response but drop the bulky HTML body into a separate extracted text for description search.
  let description: string | null = null;
  if (raw.htmlBody) {
    try {
      const { document } = parseHTML(raw.htmlBody);
      document.querySelectorAll("style,script").forEach((n: { remove(): void }) => n.remove());
      const text = cleanText(document.body?.textContent ?? "");
      description = text ? text.slice(0, 6000) : null;
    } catch {
      description = null;
    }
  }
  return {
    sourceKey: "ezamowienia",
    retrievedVia: "e-Zamówienia Official API",
    sourceNoticeId: raw.objectId,
    sourceUrl: `https://ezamowienia.gov.pl/mo-client-board/bzp/notice-details/id/${encodeURIComponent(raw.objectId)}`,
    publicationDate: raw.publicationDate ? raw.publicationDate.slice(0, 10) : null,
    originalPayload: { ...raw, htmlBody: undefined, htmlBodyLength: raw.htmlBody?.length ?? 0, bzpNumber: raw.bzpNumber, noticeNumber: raw.noticeNumber },
    contractingAuthority: raw.organizationName ?? null,
    authorityNationalId: raw.organizationNationalId ?? null,
    title: raw.orderObject ?? null,
    description,
    cpvCodes: parseCpv(raw.cpvCode),
    deadline: raw.submittingOffersDate ?? null,
    estimatedValue: null,
    currency: null,
    lots: [],
    technicalRequirements: null,
    noticeType: raw.noticeType ?? null,
    procurementStatus: raw.procedureResult ?? null,
    legalBasis: null,
    contractNature: raw.orderType ?? null,
    country: raw.organizationCountry ?? null,
    awardedSuppliers: (raw.contractors ?? []).filter((c) => c.contractorName).map((c) => ({ name: c.contractorName!, country: c.contractorCountry ?? null })),
  };
}

export interface EzSyncParams {
  noticeTypes?: (typeof EZ_NOTICE_TYPES)[number][];
  from: string; // ISO date/time
  to: string;
  cpvCode?: string;
  pageSize?: number;
  maxPages?: number;
  taskId?: number;
}

export async function syncEzamowienia(p: EzSyncParams): Promise<SyncResult> {
  const db = getDb();
  const types = p.noticeTypes ?? ["ContractNotice", "TenderResultNotice"];
  const size = Math.min(p.pageSize ?? 100, 100);
  const job = db.insert("ingestion_jobs", { connector_key: "ezamowienia", task_id: p.taskId ?? null, status: "RUNNING", params: JSON.stringify(p) });
  const r: SyncResult = { fetched: 0, created: 0, updated: 0, failed: 0, cursor: null };
  let newest: string | null = null;
  try {
    for (const type of types) {
      for (let page = 1; page <= (p.maxPages ?? 5); page++) {
        const q = new URLSearchParams({ NoticeType: type, PublicationDateFrom: p.from, PublicationDateTo: p.to, PageNumber: String(page), PageSize: String(size) });
        if (p.cpvCode) q.set("CpvCode", p.cpvCode);
        const res = await politeFetch(`${EZ_ENDPOINT}?${q.toString()}`, { respectRobots: false, timeoutMs: 60_000, taskId: p.taskId });
        if (res.status !== 200) throw new Error(`e-Zamówienia returned HTTP ${res.status}: ${res.body.slice(0, 300)}`);
        const rows = JSON.parse(res.body) as EzRaw[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const row of rows) {
          r.fetched++;
          const n = parseEzNotice(row);
          if (!n) { r.failed++; continue; }
          if (n.publicationDate && (!newest || n.publicationDate > newest)) newest = n.publicationDate;
          try {
            const out = storeNotice(n);
            if (out === "created") r.created++;
            else if (out === "updated") r.updated++;
          } catch { r.failed++; }
        }
        if (rows.length < size) break;
      }
    }
    r.cursor = p.to;
    db.update("ingestion_jobs", job, { status: "SUCCEEDED", fetched: r.fetched, created: r.created, updated: r.updated, failed: r.failed, finished_at: new Date().toISOString() });
    recordConnectorRun("ezamowienia", { ok: true, ...r });
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    db.update("ingestion_jobs", job, { status: "FAILED", error: msg, fetched: r.fetched, created: r.created, updated: r.updated, failed: r.failed, finished_at: new Date().toISOString() });
    recordConnectorRun("ezamowienia", { ok: false, error: msg, ...r, failed: r.failed + 1 });
    throw e;
  }
}
