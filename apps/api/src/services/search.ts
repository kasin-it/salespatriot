import { getDb } from "../db/db.ts";

const sanitize = (q: string): string => q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean).map((t) => `${t}*`).join(" ");

export interface SearchHit { entityType: string; entityId: number; title: string; snippet: string }

/** Structured full-text search over events, companies and procurement notices. Every hit points to a record that carries its own sources. */
export function search(q: string, types?: string[], limit = 30): SearchHit[] {
  const fts = sanitize(q);
  if (!fts) return [];
  const rows = getDb().all<{ entity_type: string; entity_id: number; title: string; snippet: string }>(
    `SELECT entity_type, entity_id, title, snippet(search_index, 3, '[', ']', '…', 12) snippet FROM search_index WHERE search_index MATCH ? ORDER BY rank LIMIT ?`, fts, limit * 3);
  return rows.filter((r) => !types?.length || types.includes(r.entity_type)).slice(0, limit).map((r) => ({ entityType: r.entity_type, entityId: r.entity_id, title: r.title, snippet: r.snippet }));
}

export function indexEvent(id: number): void {
  const db = getDb();
  const e = db.get<{ name: string; description: string | null; organizer: string | null; city: string | null; country: string | null }>("SELECT * FROM events WHERE id=?", id);
  if (!e) return;
  db.run("DELETE FROM search_index WHERE entity_type='event' AND entity_id=?", id);
  db.run("INSERT INTO search_index (entity_type, entity_id, title, body) VALUES ('event', ?, ?, ?)", id, e.name, [e.description, e.organizer, e.city, e.country].filter(Boolean).join(" "));
}
