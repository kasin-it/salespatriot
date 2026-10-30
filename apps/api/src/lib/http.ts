import { getDb } from "../db/db.ts";
import { errorMessage, now, sha256, sleep } from "./util.ts";
import { upsertSource } from "./provenance.ts";
import type { SourceType } from "@salespatriot/shared";

export const USER_AGENT = "Mozilla/5.0 (compatible; ArsenalAI-Research/0.1; +https://github.com/kasin-it/salespatriot)";

const lastHit = new Map<string, number>();
const hostIntervalMs = new Map<string, number>();
const robotsCache = new Map<string, { at: number; disallow: string[]; allow: string[] }>();

export function setHostInterval(host: string, ms: number): void {
  hostIntervalMs.set(host, ms);
}

async function throttle(host: string): Promise<void> {
  const interval = hostIntervalMs.get(host) ?? 1000;
  const wait = (lastHit.get(host) ?? 0) + interval - Date.now();
  lastHit.set(host, Math.max(Date.now(), (lastHit.get(host) ?? 0) + interval));
  if (wait > 0) await sleep(wait);
}

export interface FetchOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  respectRobots?: boolean;
  /** Persist body as a source snapshot for change detection / audit. */
  snapshot?: { sourceType: SourceType; keepBody?: boolean };
  taskId?: number;
  cacheTtlMs?: number;
  maxBytes?: number;
}

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: string;
  bytes?: Uint8Array;
  fromCache: boolean;
  hash: string;
  sourceId?: number;
}

export class FetchError extends Error {
  status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.status = status;
  }
}

async function robotsAllows(u: URL): Promise<boolean> {
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.at > 3600_000) {
    entry = { at: Date.now(), disallow: [], allow: [] };
    try {
      const res = await fetch(`${u.origin}/robots.txt`, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (res.ok && /text\/plain|text\/html|^$/.test(res.headers.get("content-type") ?? "")) {
        const text = await res.text();
        let applies = false;
        for (const raw of text.split(/\r?\n/)) {
          const line = raw.replace(/#.*/, "").trim();
          const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
          if (!m) continue;
          const k = m[1]!.toLowerCase();
          const v = m[2]!.trim();
          if (k === "user-agent") applies = v === "*" || /arsenal/i.test(v);
          else if (applies && k === "disallow" && v) entry.disallow.push(v);
          else if (applies && k === "allow" && v) entry.allow.push(v);
        }
      }
    } catch {
      /* robots unreachable: treated as no restrictions, as per RFC 9309 for 4xx; network errors are retried implicitly later */
    }
    robotsCache.set(key, entry);
  }
  const path = u.pathname + u.search;
  const match = (rules: string[]) =>
    rules.filter((r) => {
      const re = new RegExp("^" + r.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));
      return re.test(path);
    }).sort((a, b) => b.length - a.length)[0];
  const d = match(entry.disallow);
  if (!d) return true;
  const a = match(entry.allow);
  return !!a && a.length >= d.length;
}

/** Polite fetch: robots.txt, per-host rate limit, timeout, retries with exponential backoff, content hash, optional snapshot. */
export async function politeFetch(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const db = getDb();
  const u = new URL(url);
  const method = opts.method ?? "GET";
  const cacheKey = method === "GET" ? url : null;
  if (cacheKey && opts.cacheTtlMs) {
    const src = db.get<{ id: number; last_fetched_at: string; content_hash: string }>("SELECT id, last_fetched_at, content_hash FROM sources WHERE url = ?", url);
    if (src?.last_fetched_at && Date.now() - Date.parse(src.last_fetched_at) < opts.cacheTtlMs) {
      const snap = db.get<{ body: string; content_type: string; http_status: number }>(
        "SELECT body, content_type, http_status FROM source_snapshots WHERE source_id = ? AND body IS NOT NULL ORDER BY id DESC LIMIT 1", src.id);
      if (snap?.body) {
        db.insert("scraping_jobs", { url, task_id: opts.taskId ?? null, status: "CACHED", http_status: snap.http_status, from_cache: 1, duration_ms: 0 });
        return { url, finalUrl: url, status: snap.http_status, contentType: snap.content_type ?? "", body: snap.body, fromCache: true, hash: src.content_hash, sourceId: src.id };
      }
    }
  }
  if (opts.respectRobots !== false && !(await robotsAllows(u))) {
    db.insert("scraping_jobs", { url, task_id: opts.taskId ?? null, status: "ROBOTS_BLOCKED", error: "Disallowed by robots.txt" });
    if (opts.snapshot) db.run("UPDATE sources SET robots_allowed = 0, last_error = 'Disallowed by robots.txt' WHERE url = ?", url);
    throw new FetchError(`robots.txt disallows ${url}`, null);
  }
  const retries = opts.retries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const started = Date.now();
    await throttle(u.host);
    try {
      const res = await fetch(url, {
        method,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,application/xml,*/*;q=0.8", ...opts.headers },
        body: opts.body,
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        const ra = Number(res.headers.get("retry-after"));
        void ra; throw new FetchError(`HTTP ${res.status}`, res.status);
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (opts.maxBytes && buf.length > opts.maxBytes) throw new FetchError(`Response larger than ${opts.maxBytes} bytes`, res.status);
      const contentType = res.headers.get("content-type") ?? "";
      const isText = /text|json|xml|javascript/.test(contentType) || contentType === "";
      const body = isText ? new TextDecoder().decode(buf) : "";
      const hash = sha256(isText ? body : Buffer.from(buf).toString("base64"));
      db.insert("scraping_jobs", { url, task_id: opts.taskId ?? null, status: res.ok ? "OK" : "HTTP_ERROR", http_status: res.status, duration_ms: Date.now() - started });
      let sourceId: number | undefined;
      if (opts.snapshot) {
        sourceId = upsertSource(url, opts.snapshot.sourceType);
        db.update("sources", sourceId, { last_fetched_at: now(), last_http_status: res.status, content_hash: hash, last_error: res.ok ? null : `HTTP ${res.status}`, robots_allowed: 1 });
        db.insert("source_snapshots", { source_id: sourceId, http_status: res.status, content_type: contentType, content_hash: hash, byte_size: buf.length, body: opts.snapshot.keepBody === false || !isText ? null : body });
      }
      return { url, finalUrl: res.url, status: res.status, contentType, body, bytes: buf, fromCache: false, hash, sourceId };
    } catch (e) {
      lastErr = e;
      const status = e instanceof FetchError ? e.status : null;
      db.insert("scraping_jobs", { url, task_id: opts.taskId ?? null, status: "ERROR", http_status: status, duration_ms: Date.now() - started, error: errorMessage(e).slice(0, 500) });
      if (e instanceof FetchError && e.status && e.status < 500 && e.status !== 429) break;
      if (attempt < retries) await sleep(Math.min(30_000, 500 * 2 ** attempt + Math.random() * 250));
    }
  }
  if (opts.snapshot) {
    const id = upsertSource(url, opts.snapshot.sourceType);
    db.update("sources", id, { last_error: errorMessage(lastErr).slice(0, 500) });
  }
  throw lastErr instanceof FetchError ? lastErr : new FetchError(errorMessage(lastErr));
}
