// Import the public-data snapshot (seed/snapshot/*.jsonl.gz: TED + e-Zamówienia, pulled 29–30 Oct 2026)
// into the app DB through the same parsers and storeNotice() as a live sync. Safe to rerun (unchanged rows are skipped).
// Run: pnpm --filter @salespatriot/api seed:snapshot   (the server may keep running: SQLite WAL)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseTedNotice } from "../src/connectors/ted.ts";
import { parseEzNotice } from "../src/connectors/ezamowienia.ts";
import { storeNotice, recordConnectorRun } from "../src/services/procurement-store.ts";
import { getDb } from "../src/db/db.ts";

const DIR = resolve(import.meta.dirname, "../seed/snapshot");
const BATCH = 500; // short transactions so a running server isn't blocked

type Raw = Record<string, unknown>;
const lines = (f: string): Raw[] => gunzipSync(readFileSync(resolve(DIR, f))).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Raw);
const arr = (v: unknown) => (v == null ? undefined : Array.isArray(v) ? v : [v]);

// The snapshot was pulled with slightly different TED field names than the connector requests; alias them.
function tedAliases(r: Raw): Raw {
  const x = { ...r };
  x["classification-cpv"] ??= arr(r["main-classification-proc"]);
  if (x["estimated-value-lot"] == null && r["estimated-value-proc"] != null) {
    x["estimated-value-lot"] = arr(r["estimated-value-proc"]);
    x["estimated-value-cur-lot"] ??= arr(r["estimated-value-cur-proc"]);
  }
  // Award value only when there is exactly one (flattened lot arrays can't be paired reliably).
  const tv = arr(r["total-value"]);
  if (x["result-value-notice"] == null && tv?.length === 1) x["result-value-notice"] = tv[0];
  x["tender-value-cur"] ??= arr(r["total-value-cur"]);
  x["description-lot"] ??= r["description-proc"];
  return x;
}

function load(file: string, source: "ted" | "ezamowienia", parse: (r: Raw) => ReturnType<typeof parseTedNotice>) {
  const rows = lines(file);
  const db = getDb();
  const c = { created: 0, updated: 0, unchanged: 0, skipped: 0 };
  for (let i = 0; i < rows.length; i += BATCH) {
    db.raw.exec("BEGIN");
    try {
      for (const r of rows.slice(i, i + BATCH)) {
        const n = parse(r);
        if (!n) { c.skipped++; continue; }
        n.retrievedVia += " (snapshot pulled 29–30 Oct 2026, seed/snapshot)";
        c[storeNotice(n)]++;
      }
      db.raw.exec("COMMIT");
    } catch (e) {
      db.raw.exec("ROLLBACK");
      throw e;
    }
  }
  recordConnectorRun(source, { ok: true, fetched: rows.length, created: c.created, updated: c.updated });
  console.log(`${file}: ${rows.length} rows →`, c);
}

for (const f of ["ted_demand_open.jsonl.gz", "ted_au_5y.jsonl.gz", "ted_eda_5y.jsonl.gz", "ted_awards_5y.jsonl.gz"]) load(f, "ted", (r) => parseTedNotice(tedAliases(r)));
for (const f of ["ezam_demand_12m.jsonl.gz", "ezam_awards_12m.jsonl.gz"]) load(f, "ezamowienia", (r) => parseEzNotice(r as Parameters<typeof parseEzNotice>[0]));
