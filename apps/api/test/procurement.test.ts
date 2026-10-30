import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { parseTedNotice, buildTedQuery } from "../src/connectors/ted.ts";
import { parseEzNotice } from "../src/connectors/ezamowienia.ts";
import { storeNotice } from "../src/services/procurement-store.ts";

// FIXTURE shaped like the real TED response (structure verified live on 2026-10-30). Test-only.
const tedFixture = { "publication-number": "000001-2099", "notice-type": "cn-standard", "buyer-name": { pol: ["Agencja Uzbrojenia"] }, "buyer-country": ["POL"], "publication-date": "2099-01-02+01:00", "classification-cpv": ["38636000", "38636000"], "notice-title": { pol: "Polska – Test" }, "description-lot": { pol: ["Dostawa celowników"] }, "legal-basis": ["32009L0081"], "deadline-receipt-tender-date-lot": [], links: { html: { ENG: "https://ted.europa.eu/en/notice/-/detail/000001-2099" } } };

test("TED parsing: authority, CPV dedup, absent deadline stays null, original URL kept", () => {
  const n = parseTedNotice(tedFixture)!;
  assert.equal(n.contractingAuthority, "Agencja Uzbrojenia");
  assert.deepEqual(n.cpvCodes, ["38636000"]);
  assert.equal(n.deadline, null);
  assert.equal(n.estimatedValue, null);
  assert.equal(n.sourceUrl, "https://ted.europa.eu/en/notice/-/detail/000001-2099");
  assert.equal(n.country, "PL");
});

test("storeNotice: dedupe by source id, update on change, tag authority, completeness reported, never invents", () => {
  const db = freshDb();
  const n = parseTedNotice(tedFixture)!;
  assert.equal(storeNotice(n), "created");
  assert.equal(storeNotice(n), "unchanged");
  assert.equal(storeNotice({ ...n, title: "Changed" }), "updated");
  const row = db.get<{ authority_tags: string; missing_fields: string; data_completeness: number; estimated_value: number | null; deadline: string | null; demand_class: string }>("SELECT * FROM procurement_notices")!;
  assert.deepEqual(JSON.parse(row.authority_tags), ["AGENCJA_UZBROJENIA"]);
  assert.ok(JSON.parse(row.missing_fields).includes("deadline"));
  assert.equal(row.estimated_value, null);
  assert.equal(row.deadline, null);
  assert.ok(row.data_completeness < 1);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM procurement_notices")!.n, 1);
});

test("award notices are HISTORICAL, never confirmed demand; open calls with future deadline are CONFIRMED", () => {
  const db = freshDb();
  storeNotice({ ...parseTedNotice(tedFixture)!, noticeType: "can-standard" });
  storeNotice({ ...parseTedNotice({ ...tedFixture, "publication-number": "000002-2099" })!, deadline: "2099-12-31T00:00:00" });
  const rows = db.all<{ source_notice_id: string; demand_class: string }>("SELECT source_notice_id, demand_class FROM procurement_notices ORDER BY source_notice_id");
  assert.equal(rows[0]!.demand_class, "HISTORICAL_DEMAND");
  assert.equal(rows[1]!.demand_class, "CONFIRMED_DEMAND");
});

test("e-Zamówienia parsing: missing CPV/deadline stay empty; low-value notice is kept", () => {
  const n = parseEzNotice({ noticeType: "ContractNotice", noticeNumber: "2099/BZP 1/01", objectId: "abc", publicationDate: "2099-01-01T00:00:00Z", orderObject: "Dostawa X", cpvCode: null, submittingOffersDate: null, organizationName: "Gmina Test", organizationCountry: "PL", htmlBody: "<html><body><p>Opis</p></body></html>" })!;
  assert.deepEqual(n.cpvCodes, []); assert.equal(n.deadline, null); assert.equal(n.description, "Opis");
  const db = freshDb(); assert.equal(storeNotice(n), "created");
  assert.ok(JSON.parse(db.get<{ missing_fields: string }>("SELECT missing_fields FROM procurement_notices")!.missing_fields).includes("cpv_codes"));
});

test("TED query builder refuses unbounded imports", () => {
  assert.throws(() => buildTedQuery({}), /unbounded/);
  assert.match(buildTedQuery({ filter: "eda", sinceDate: "2026-01-01" }), /publication-date >= 20260101/);
});
