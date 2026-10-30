import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDb } from "./helpers.ts";
import { resolveCompany } from "../src/services/companies.ts";
import { normalizeCompanyName } from "../src/lib/util.ts";
import { onboardCompany } from "../src/services/onboarding.ts";

const base = { origin: "t", sourceUrl: "https://example.test/x", sourceType: "OFFICIAL_EVENT_WEBSITE", factKind: "COMPANY_PUBLISHED", evidence: "e" } as const;

test("normalisation strips legal forms and diacritics", () => {
  assert.equal(normalizeCompanyName('"ALSTOR" A.ZWIERZYŃSKI SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ'), "alstor a zwierzynski");
  assert.equal(normalizeCompanyName("Rheinmetall AG"), "rheinmetall");
});

test("same company at two events resolves to one record (domain, then name+country)", () => {
  freshDb();
  const a = resolveCompany({ ...base, name: "Blighter Surveillance Systems Ltd", country: "GB", website: "https://www.blighter.com" });
  const b = resolveCompany({ ...base, name: "BLIGHTER SURVEILLANCE SYSTEMS LIMITED", country: "GB", website: "blighter.com/en" });
  assert.equal(a.companyId, b.companyId);
  assert.equal(b.matchedBy, "domain");
  const c = resolveCompany({ ...base, name: "Blighter Surveillance Systems", country: "GB" });
  assert.equal(c.companyId, a.companyId);
  assert.equal(c.matchedBy, "name+country");
});

test("similar names alone never merge; contradicting websites keep records apart", () => {
  const db = freshDb();
  const a = resolveCompany({ ...base, name: "Alpha Defence Systems", country: "PL", website: "alpha-defence.pl" });
  const b = resolveCompany({ ...base, name: "Alpha Defence Systems", country: "PL", website: "alphadefence.com" });
  assert.notEqual(a.companyId, b.companyId);
  const c = resolveCompany({ ...base, name: "Alpha Defence Systems Group", country: "PL" });
  assert.notEqual(c.companyId, a.companyId);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM companies")!.n, 3);
});

test("ambiguous exact-name matches without corroboration become NEEDS_REVIEW", () => {
  const db = freshDb();
  resolveCompany({ ...base, name: "Delta Optics", country: "DE", website: "delta-optics.de" });
  resolveCompany({ ...base, name: "Delta Optics", country: "DE", website: "deltaoptics.eu" });
  const r = resolveCompany({ ...base, name: "Delta Optics", country: "DE" });
  assert.equal(r.created, true);
  assert.equal(db.get<{ identity_state: string }>("SELECT identity_state FROM companies WHERE id=?", r.companyId)!.identity_state, "NEEDS_REVIEW");
});

test("registry identifier match wins over name", () => {
  freshDb();
  const a = resolveCompany({ ...base, name: "Foo Sp. z o.o.", country: "PL", identifiers: [{ scheme: "LEI", value: "TESTLEI0000000000001" }] });
  const b = resolveCompany({ ...base, name: "Completely Different Trading Name", country: "PL", identifiers: [{ scheme: "LEI", value: "TESTLEI0000000000001" }] });
  assert.equal(a.companyId, b.companyId);
  assert.equal(b.matchedBy, "identifier");
});

test("onboarding creates unverified identifiers, admin membership, and queues identity task; second user cannot hijack", () => {
  const db = freshDb();
  const u1 = db.insert("users", { email: "a@acme-test.example", name: "A", password_hash: "x" });
  const u2 = db.insert("users", { email: "b@other.example", name: "B", password_hash: "x" });
  const r = onboardCompany({ userId: u1, legalName: "Acme Test Sp. z o.o.", website: "https://acme-test.example", country: "PL", vat: "PL 123", jobTitle: "CEO", authorizationLevel: "SIGNATORY" });
  assert.ok(r.taskId);
  assert.equal(db.get<{ verified: number }>("SELECT verified FROM company_identifiers WHERE company_id=? AND scheme='VAT'", r.companyId)!.verified, 0);
  assert.equal(db.get<{ email_domain_verified: number }>("SELECT email_domain_verified FROM company_memberships WHERE company_id=?", r.companyId)!.email_domain_verified, 1);
  assert.throws(() => onboardCompany({ userId: u2, legalName: "Acme Test Sp. z o.o.", website: "https://acme-test.example", country: "PL" }), /already has an administrator/);
});
