import { getDb } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { domainOf, normalizeCompanyName, normalizeUrl, now, sha256 } from "../lib/util.ts";
import { recordFact, upsertSource } from "../lib/provenance.ts";
import { politeFetch } from "../lib/http.ts";
import { findDirectoryLinks, findDocumentLinks, parseEventPage } from "../connectors/event-pages.ts";
import { extractorFor, type ExhibitorRecord } from "../connectors/exhibitors.ts";
import { classifyText } from "../lib/taxonomy.ts";
import { resolveCompany } from "./companies.ts";
import type { TaskContext } from "../agents/orchestrator.ts";

export interface AddEventInput {
  url: string;
  userId?: number | null;
  discoveredVia: "USER_URL" | "DISCOVERY_AGENT";
}

export function addEvent(input: AddEventInput): { id: number; created: boolean } {
  const url = normalizeUrl(input.url);
  if (!url) throw new Error("A valid http(s) URL is required");
  const db = getDb();
  const existing = db.get<{ id: number }>("SELECT id FROM events WHERE official_url = ?", url);
  if (existing) return { id: existing.id, created: false };
  const id = db.insert("events", { name: domainOf(url) ?? url, official_url: url, discovered_via: input.discoveredVia, created_by_user_id: input.userId ?? null, research_status: "NOT_STARTED" });
  upsertSource(url, "OFFICIAL_EVENT_WEBSITE");
  db.run("INSERT OR IGNORE INTO event_sources (event_id, source_id, role) VALUES (?, (SELECT id FROM sources WHERE url=?), 'official_site')", id, url);
  audit({ actorType: input.userId ? "user" : "agent", actorId: input.userId ?? "event_discovery", action: "event.created", entityType: "event", entityId: id, summary: `Event added from ${url}` });
  return { id, created: true };
}

const iso = (d: string) => d;

/** Event Research: official page facts, directory discovery, documents, exhibitor extraction. Resumable and idempotent. */
export async function researchEvent(ctx: TaskContext, eventId: number): Promise<Record<string, unknown>> {
  const db = getDb();
  const ev = db.get<{ official_url: string; name: string; start_date: string | null }>("SELECT * FROM events WHERE id = ?", eventId);
  if (!ev) throw new Error(`Event ${eventId} not found`);
  db.update("events", eventId, { research_status: "RUNNING" });
  const report: Record<string, unknown> = {};
  try {
    ctx.progress("Fetching official event page");
    const page = await politeFetch(ev.official_url, { taskId: ctx.taskId, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE" } });
    if (page.status !== 200) throw new Error(`Official site returned HTTP ${page.status}`);
    const info = parseEventPage(page.body, page.finalUrl);
    const sid = page.sourceId ?? upsertSource(ev.official_url, "OFFICIAL_EVENT_WEBSITE");
    const name = info.siteName ?? info.title?.split(/[|–—-]/)[0]?.trim() ?? ev.name;
    // Dates: only explicit ranges on the page; prefer the next upcoming range, else the most recent one.
    const today = new Date().toISOString().slice(0, 10);
    const ranges = [...info.dateRanges].sort((a, b) => a.start.localeCompare(b.start));
    const range = ranges.find((r) => r.end >= today) ?? ranges.at(-1);
    db.update("events", eventId, {
      name, description: info.description ?? undefined, organizer: info.organizer ?? undefined,
      start_date: range ? iso(range.start) : undefined, end_date: range ? iso(range.end) : undefined,
      dates_evidence: range?.evidence, dates_source_url: range ? ev.official_url : undefined,
    });
    recordFact({ entityType: "event", entityId: eventId, field: "name", value: name, sourceUrl: ev.official_url, sourceType: "OFFICIAL_EVENT_WEBSITE", factKind: "COMPANY_PUBLISHED", evidence: info.title, confidence: 0.9 });
    if (range) recordFact({ entityType: "event", entityId: eventId, field: "dates", value: `${range.start}..${range.end}`, sourceUrl: ev.official_url, sourceType: "OFFICIAL_EVENT_WEBSITE", factKind: "COMPANY_PUBLISHED", evidence: range.evidence, confidence: 0.75, verification: "UNVERIFIED" });
    report.dates = range ? `${range.start}..${range.end}` : "not found on page";
    // Relevance classification from page text only.
    const hits = classifyText(`${info.title ?? ""} ${info.description ?? ""} ${info.text.slice(0, 20000)}`);
    db.run("DELETE FROM event_categories WHERE event_id = ?", eventId);
    for (const h of hits) db.run("INSERT INTO event_categories (event_id, category, evidence_text) VALUES (?,?,?)", eventId, h.key, `Term "${h.term}" on official page`);
    const defence = /defen[cs]e|military|armed forces|security|aerospace|obron|wojsk|verteidigung|sicherheit/i.test(info.text);
    db.update("events", eventId, { relevance_score: Math.min(1, hits.length / 6 + (defence ? 0.3 : 0)), relevance_reasons: JSON.stringify(hits.map((h) => `${h.label} ("${h.term}")`)) });

    // Documents
    for (const d of findDocumentLinks(info)) db.run("INSERT OR IGNORE INTO event_documents (event_id, url, title, doc_type) VALUES (?,?,?,?)", eventId, d.href, d.text || null, d.href.split("?")[0]!.split(".").pop()!.toLowerCase());
    report.documents = db.get<{ n: number }>("SELECT COUNT(*) n FROM event_documents WHERE event_id=?", eventId)!.n;

    // Exhibitor directory
    ctx.progress("Locating exhibitor directory");
    const extractor = extractorFor(ev.official_url);
    const candidates = findDirectoryLinks(info);
    report.directoryCandidates = candidates.map((c) => c.href);
    if (!extractor) {
      const note = candidates.length
        ? `No server-side extractor for this site. Directory candidates found: ${candidates.map((c) => c.href).join(", ")}. They may be JavaScript-rendered; use an authorised browser MCP or import an official export.`
        : "No exhibitor directory link found on the official page and no extractor available.";
      db.update("events", eventId, { exhibitor_directory_url: candidates[0]?.href ?? undefined, exhibitor_strategy: note, research_status: "COMPLETED_NO_DIRECTORY", last_researched_at: now() });
      db.insert("event_updates", { event_id: eventId, kind: "RESEARCH_LIMITATION", summary: note, source_url: ev.official_url });
      report.exhibitors = 0;
      return report;
    }
    const dirUrl = extractor.directoryUrl(ev.official_url);
    db.update("events", eventId, { exhibitor_directory_url: dirUrl, exhibitor_strategy: extractor.label });
    upsertSource(dirUrl, "OFFICIAL_EVENT_WEBSITE", "Official exhibitor directory");
    db.run("INSERT OR IGNORE INTO event_sources (event_id, source_id, role) VALUES (?, (SELECT id FROM sources WHERE url=?), 'exhibitor_directory')", eventId, dirUrl);
    ctx.progress(`Reading exhibitor list via ${extractor.label}`);
    const maxList = typeof ctx.payload.maxExhibitors === "number" ? ctx.payload.maxExhibitors : undefined;
    const list = await extractor.list({ eventUrl: ev.official_url, taskId: ctx.taskId, maxList, setDirectoryUrl: (u) => { db.update("events", eventId, { exhibitor_directory_url: u }); upsertSource(u, "OFFICIAL_EVENT_WEBSITE", "Official exhibitor directory"); } });
    if (list.length === 0) throw new Error("Exhibitor directory was reachable but yielded zero exhibitors; refusing to report success");
    const stats = storeExhibitors(eventId, list);
    Object.assign(report, stats, { exhibitorsListed: list.length });
    db.insert("event_snapshots", { event_id: eventId, source_id: sid, content_hash: page.hash, exhibitor_count: list.length, exhibitor_hash: sha256(list.map((r) => r.externalId ?? r.name).sort().join("|")) });
    ctx.action("exhibitors.extracted", "event", eventId, stats);
    // Detail pages in bounded batches so the task stays resumable.
    ctx.spawn("event_research", "event.exhibitor_details", { eventId, batch: 0 }, { dedupeKey: `exh-details:${eventId}:0`, entityType: "event", entityId: eventId });
    db.update("events", eventId, { research_status: "COMPLETED", last_researched_at: now() });
    return report;
  } catch (e) {
    db.update("events", eventId, { research_status: "FAILED", last_researched_at: now() });
    throw e;
  }
}

export function storeExhibitors(eventId: number, list: ExhibitorRecord[]): { added: number; updated: number } {
  const db = getDb();
  let added = 0, updated = 0;
  db.tx(() => {
    for (const r of list) {
      const norm = normalizeCompanyName(r.name);
      const existing = r.externalId
        ? db.get<{ id: number; stub: number }>("SELECT id, resolution_status = 'PENDING_DETAIL' AS stub FROM event_exhibitors WHERE event_id=? AND external_id=?", eventId, r.externalId)
        : db.get<{ id: number; stub: number }>("SELECT id, 0 AS stub FROM event_exhibitors WHERE event_id=? AND normalized_name=?", eventId, norm);
      if (!existing) {
        db.insert("event_exhibitors", {
          event_id: eventId, external_id: r.externalId, exhibitor_name: r.name, normalized_name: r.stub ? `${norm}#${r.externalId}` : norm, country: r.country, city: r.city, website: r.website, booth: r.booth,
          description: r.description, categories: JSON.stringify(r.categories), profile_url: r.profileUrl, source_url: r.sourceUrl, evidence_text: r.evidence,
          resolution_status: r.stub ? "PENDING_DETAIL" : "PENDING", detail_fetched_at: r.stub ? null : now(),
        }, "ON CONFLICT(event_id, normalized_name) DO UPDATE SET last_seen_at = excluded.last_seen_at");
        added++;
      } else {
        const patch: Record<string, string | number | null | undefined> = { last_seen_at: now(), removed_at: null };
        if (!r.stub) Object.assign(patch, { exhibitor_name: r.name, normalized_name: norm, country: r.country, city: r.city, website: r.website, booth: r.booth, description: r.description, categories: JSON.stringify(r.categories), evidence_text: r.evidence, detail_fetched_at: now(), resolution_status: "PENDING" });
        db.update("event_exhibitors", existing.id, patch);
        updated++;
      }
    }
  });
  return { added, updated };
}

/** Resolve one fetched exhibitor to a canonical company and attach it to the event. */
export function resolveExhibitor(exhibitorId: number): number | null {
  const db = getDb();
  const x = db.get<{ id: number; event_id: number; exhibitor_name: string; country: string | null; website: string | null; source_url: string; evidence_text: string | null; profile_url: string | null; resolution_status: string }>("SELECT * FROM event_exhibitors WHERE id = ?", exhibitorId);
  if (!x || x.resolution_status === "PENDING_DETAIL") return null;
  const ev = db.get<{ name: string }>("SELECT name FROM events WHERE id=?", x.event_id)!;
  const r = resolveCompany({
    name: x.exhibitor_name, country: x.country, website: x.website, origin: `event:${ev.name}`,
    sourceUrl: x.profile_url ?? x.source_url, sourceType: "OFFICIAL_EVENT_WEBSITE", factKind: "COMPANY_PUBLISHED", evidence: x.evidence_text,
  });
  db.update("event_exhibitors", x.id, { company_id: r.companyId, resolution_status: r.created ? "NEW_COMPANY" : `MATCHED_${r.matchedBy.toUpperCase()}` });
  return r.companyId;
}
