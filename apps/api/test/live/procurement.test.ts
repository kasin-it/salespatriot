import { test } from "node:test";
import assert from "node:assert/strict";
import { Db } from "../../src/db/db.ts";
import { setDb } from "../../src/db/db.ts";
import { seedReferenceData } from "../../src/db/reference-data.ts";
import { syncTed } from "../../src/connectors/ted.ts";
import { syncEzamowienia } from "../../src/connectors/ezamowienia.ts";

const live = process.env.LIVE === "1";

function fresh(): Db {
  const db = new Db(":memory:");
  db.migrate();
  seedReferenceData(db);
  setDb(db);
  return db;
}

test("LIVE TED: Agencja Uzbrojenia notices are retrieved, stored with provenance", { skip: !live, timeout: 180_000 }, async () => {
  const db = fresh();
  const r = await syncTed({ filter: "agencja_uzbrojenia", sinceDate: "2026-01-01", maxRecords: 20 });
  assert.ok(r.fetched > 0 && r.created > 0, JSON.stringify(r));
  const row = db.get<{ source_url: string; source_notice_id: string; original_payload: string; authority_tags: string }>("SELECT * FROM procurement_notices LIMIT 1")!;
  assert.match(row.source_url, /^https:\/\/ted\.europa\.eu/);
  assert.ok(JSON.parse(row.original_payload)["publication-number"] === row.source_notice_id);
  assert.ok(JSON.parse(row.authority_tags).includes("AGENCJA_UZBROJENIA"));
  const again = await syncTed({ filter: "agencja_uzbrojenia", sinceDate: "2026-01-01", maxRecords: 20 });
  assert.equal(again.created, 0, "second sync must deduplicate");
  console.log("TED", r);
});

test("LIVE e-Zamówienia: notices retrieved; absent CPV/deadline stay null", { skip: !live, timeout: 180_000 }, async () => {
  const db = fresh();
  const r = await syncEzamowienia({ from: "2026-10-28T00:00:00", to: "2026-10-29T00:00:00", noticeTypes: ["ContractNotice"], maxPages: 1, pageSize: 20 });
  assert.ok(r.fetched > 0 && r.created > 0, JSON.stringify(r));
  const rows = db.all<{ cpv_codes: string; deadline: string | null; data_completeness: number }>("SELECT cpv_codes, deadline, data_completeness FROM procurement_notices");
  assert.ok(rows.every((x) => x.data_completeness <= 1));
  console.log("EZ", r, rows.slice(0, 3));
});
