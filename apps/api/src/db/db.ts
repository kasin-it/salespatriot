import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { migrations } from "./migrations.ts";
import { seedReferenceData } from "./reference-data.ts";

export type Row = Record<string, unknown>;
export type Param = SQLInputValue;

let instance: Db | null = null;

export class Db {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  }

  all<T = Row>(sql: string, ...params: Param[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  get<T = Row>(sql: string, ...params: Param[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number } {
    const r = this.raw.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** INSERT helper: keys of `values` become columns. Undefined values are skipped. */
  insert(table: string, values: Record<string, Param | undefined>, onConflict = ""): number {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined) as [string, Param][];
    const cols = entries.map(([k]) => k).join(", ");
    const marks = entries.map(() => "?").join(", ");
    const r = this.run(`INSERT INTO ${table} (${cols}) VALUES (${marks}) ${onConflict}`, ...entries.map(([, v]) => v));
    return r.lastInsertRowid;
  }

  update(table: string, id: number | string, values: Record<string, Param | undefined>, idCol = "id"): void {
    const entries = Object.entries(values).filter(([, v]) => v !== undefined) as [string, Param][];
    if (entries.length === 0) return;
    const set = entries.map(([k]) => `${k} = ?`).join(", ");
    this.run(`UPDATE ${table} SET ${set} WHERE ${idCol} = ?`, ...entries.map(([, v]) => v), id);
  }

  tx<T>(fn: () => T): T {
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  migrate(): number[] {
    this.raw.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)",
    );
    const applied = new Set(this.all<{ id: number }>("SELECT id FROM schema_migrations").map((r) => r.id));
    const ran: number[] = [];
    for (const m of migrations) {
      if (applied.has(m.id)) continue;
      this.tx(() => {
        this.raw.exec(m.sql);
        this.run("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)", m.id, m.name, new Date().toISOString());
      });
      ran.push(m.id);
    }
    return ran;
  }

  close(): void {
    this.raw.close();
  }
}

export function dbPath(): string {
  return process.env.ARSENAL_DB_PATH ?? resolve(import.meta.dirname, "../../data/arsenal.db");
}

export function getDb(): Db {
  if (!instance) {
    instance = new Db(dbPath());
    instance.migrate();
    seedReferenceData(instance);
  }
  return instance;
}

/** Tests swap in an isolated in-memory database. */
export function setDb(db: Db | null): void {
  instance = db;
}

export function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value === "") return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
