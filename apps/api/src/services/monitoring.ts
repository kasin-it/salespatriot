import { getDb } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { now, sha256 } from "../lib/util.ts";
import { politeFetch } from "../lib/http.ts";
import { parseEventPage } from "../connectors/event-pages.ts";
import { extractorFor } from "../connectors/exhibitors.ts";
import { storeExhibitors } from "./events.ts";
import type { TaskContext } from "../agents/orchestrator.ts";

export function enableMonitoring(eventId: number, intervalMinutes: number): void {
  const db = getDb();
  const next = new Date(Date.now() + intervalMinutes * 60_000).toISOString();
  db.run(`INSERT INTO event_monitoring_jobs (event_id, interval_minutes, enabled, next_run_at) VALUES (?, ?, 1, ?)
          ON CONFLICT(event_id) DO UPDATE SET interval_minutes = excluded.interval_minutes, enabled = 1, next_run_at = excluded.next_run_at`, eventId, intervalMinutes, next);
  audit({ actorType: "system", action: "monitoring.enabled", entityType: "event", entityId: eventId, summary: `Polling every ${intervalMinutes} min (periodic, not real-time)` });
}

/** Called by the scheduler: queue a monitoring task for every due job. */
export function dueMonitoringJobs(): number[] {
  return getDb().all<{ event_id: number }>("SELECT event_id FROM event_monitoring_jobs WHERE enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)", now()).map((r) => r.event_id);
}

/** Compare current official page + exhibitor directory with the stored snapshot and record every difference as an event update. */
export async function monitorEvent(ctx: TaskContext, eventId: number): Promise<{ changes: number }> {
  const db = getDb();
  const ev = db.get<{ official_url: string; start_date: string | null; end_date: string | null; exhibitor_directory_url: string | null }>("SELECT * FROM events WHERE id=?", eventId);
  const job = db.get<{ interval_minutes: number }>("SELECT * FROM event_monitoring_jobs WHERE event_id=?", eventId);
  if (!ev || !job) throw new Error("Event is not monitored");
  let changes = 0;
  const bump = (kind: string, summary: string, before: string | null, after: string | null, url: string | null) => {
    db.insert("event_updates", { event_id: eventId, kind, summary, before_value: before, after_value: after, source_url: url });
    changes++;
  };
  try {
    const prevSnap = db.get<{ content_hash: string; exhibitor_hash: string | null }>("SELECT content_hash, exhibitor_hash FROM event_snapshots WHERE event_id=? ORDER BY id DESC LIMIT 1", eventId);
    const page = await politeFetch(ev.official_url, { taskId: ctx.taskId, snapshot: { sourceType: "OFFICIAL_EVENT_WEBSITE" } });
    const pageChanged = !!prevSnap && prevSnap.content_hash !== page.hash;
    const info = parseEventPage(page.body, page.finalUrl);
    const range = [...info.dateRanges].sort((a, b) => a.start.localeCompare(b.start)).find((r) => r.end >= new Date().toISOString().slice(0, 10));
    if (range && (range.start !== ev.start_date || range.end !== ev.end_date) && ev.start_date) {
      bump("DATES_CHANGED", `Dates on official page changed`, `${ev.start_date}..${ev.end_date}`, `${range.start}..${range.end}`, ev.official_url);
      db.update("events", eventId, { start_date: range.start, end_date: range.end, dates_evidence: range.evidence });
    }
    if (pageChanged) bump("PAGE_CONTENT_CHANGED", "Official event page content changed", prevSnap!.content_hash.slice(0, 12), page.hash.slice(0, 12), ev.official_url);
    let exHash: string | null = prevSnap?.exhibitor_hash ?? null;
    let exCount: number | null = null;
    const extractor = extractorFor(ev.official_url);
    if (extractor) {
      const list = await extractor.list({ eventUrl: ev.official_url, taskId: ctx.taskId });
      exCount = list.length;
      const key = (r: { externalId: string | null; name: string }) => r.externalId ?? r.name;
      const current = new Set(list.map(key));
      const known = db.all<{ id: number; external_id: string | null; exhibitor_name: string; removed_at: string | null }>("SELECT id, external_id, exhibitor_name, removed_at FROM event_exhibitors WHERE event_id=?", eventId);
      const knownKeys = new Set(known.map((k) => k.external_id ?? k.exhibitor_name));
      // Safety: an empty or drastically smaller list is more likely a broken fetch than mass withdrawal.
      const plausible = list.length > 0 && list.length >= known.length * 0.5;
      const added = list.filter((r) => !knownKeys.has(key(r)));
      if (added.length) {
        storeExhibitors(eventId, added);
        bump("EXHIBITORS_ADDED", `${added.length} new exhibitor(s) in the official directory: ${added.slice(0, 5).map((a) => a.name).join(", ")}${added.length > 5 ? "…" : ""}`, null, String(added.length), ev.exhibitor_directory_url);
        ctx.spawn("event_research", "event.exhibitor_details", { eventId, batch: 0 }, { dedupeKey: `exh-details:${eventId}:0`, entityType: "event", entityId: eventId });
      }
      if (plausible) {
        const removed = known.filter((k) => !k.removed_at && !current.has(k.external_id ?? k.exhibitor_name));
        for (const r of removed) db.update("event_exhibitors", r.id, { removed_at: now() });
        if (removed.length) bump("EXHIBITORS_REMOVED", `${removed.length} exhibitor(s) no longer in the official directory: ${removed.slice(0, 5).map((r) => r.exhibitor_name).join(", ")}`, String(removed.length), null, ev.exhibitor_directory_url);
      } else bump("SOURCE_ANOMALY", `Directory returned ${list.length} entries vs ${known.length} known; removals not applied until confirmed`, String(known.length), String(list.length), ev.exhibitor_directory_url);
      exHash = sha256([...current].sort().join("|"));
    }
    db.insert("event_snapshots", { event_id: eventId, source_id: page.sourceId ?? null, content_hash: page.hash, exhibitor_count: exCount, exhibitor_hash: exHash });
    db.run(`UPDATE event_monitoring_jobs SET last_checked_at=?, last_success_at=?, last_error=NULL, changes_detected = changes_detected + ?, next_run_at=? WHERE event_id=?`,
      now(), now(), changes, new Date(Date.now() + job.interval_minutes * 60_000).toISOString(), eventId);
    if (changes) audit({ actorType: "agent", actorId: "event_monitoring", action: "event.changes_detected", entityType: "event", entityId: eventId, summary: `${changes} change(s) detected on event ${eventId}` });
    return { changes };
  } catch (e) {
    db.run("UPDATE event_monitoring_jobs SET last_checked_at=?, last_error=?, next_run_at=? WHERE event_id=?", now(), e instanceof Error ? e.message : String(e), new Date(Date.now() + job.interval_minutes * 60_000).toISOString(), eventId);
    throw e;
  }
}
