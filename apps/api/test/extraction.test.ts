import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseKielceDetail, parseKielceSitemap, parseEnforceDetail, parseEnforceSitemap, parseDseiList } from "../src/connectors/exhibitors.ts";
import { findDateRanges } from "../src/connectors/event-pages.ts";
import { classifyText, categoriesForCpv } from "../src/lib/taxonomy.ts";
import { parseTermsFromText } from "../src/services/communication.ts";

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), "utf8");

test("MSPO profile page fixture: name, country, website extracted with evidence", () => {
  const r = parseKielceDetail(fx("FIXTURE_mspo_detail.html"), "https://www.targikielce.pl/en/mspo-2026/list-of-exhibitors/blighter-surveillance-systems-ltd,3812480", "3812480")!;
  assert.equal(r.name, "Blighter Surveillance Systems Ltd");
  assert.equal(r.country, "GB");
  assert.equal(r.website, "https://www.blighter.com/");
  assert.match(r.evidence, /Blighter/);
});

test("Kielce sitemap parsing keeps only the requested fair and dedupes ids", () => {
  const xml = `<urlset><url><loc>https://www.targikielce.pl/en/mspo-2026/list-of-exhibitors/a-b,1</loc></url><url><loc>https://www.targikielce.pl/en/mspo-2026/list-of-exhibitors/a-b,1</loc></url><url><loc>https://www.targikielce.pl/en/other-fair/list-of-exhibitors/x,2</loc></url></urlset>`;
  assert.deepEqual(parseKielceSitemap(xml, "mspo-2026").map((e) => e.id), ["1"]);
});

test("Enforce Tac profile fixture via embedded page data", () => {
  const r = parseEnforceDetail(fx("FIXTURE_enforcetac_detail.html"), "https://www.enforcetac.com/en/exhibitors/condor-mfg-co-2632336")!;
  assert.equal(r.name, "CONDOR MFG CO.");
  assert.equal(r.country, "PK");
  assert.equal(r.booth, "9-178");
  assert.match(r.website ?? "", /condormanufacturing\.com/);
  assert.ok(r.categories.length > 0);
  assert.equal(parseEnforceSitemap("<loc>https://www.enforcetac.com/en/exhibitors/x-co-12</loc><loc>https://www.enforcetac.com/en/exhibitors/x-co-12/products</loc>").length, 1);
});

test("DSEI list fixture yields real rows", () => {
  const rows = parseDseiList(fx("FIXTURE_dsei_list.html"), "https://www.dsei.co.uk/visit/exhibiting-companies?page=1");
  assert.ok(rows.length > 5);
  assert.ok(rows.every((r) => r.name && r.evidence.includes("exhibitor list")));
});

test("date ranges are only taken when explicitly written", () => {
  const t = "The 34th edition will take place on 8-11 September 2026 in Kielce. Next: 31 August - 3 September 2027.";
  const r = findDateRanges(t);
  assert.deepEqual(r.map((x) => [x.start, x.end]), [["2026-09-08", "2026-09-11"], ["2027-08-31", "2027-09-03"]]);
  assert.deepEqual(findDateRanges("Coming soon, stay tuned for dates"), []);
});

test("taxonomy classification needs real terms; CPV maps to categories", () => {
  assert.ok(classifyText("We manufacture holographic sights and night vision devices").some((h) => h.key === "optics_sights"));
  assert.deepEqual(classifyText("We bake bread and cakes"), []);
  assert.ok(categoriesForCpv(["38636000"]).includes("optics_sights"));
  assert.ok(categoriesForCpv(["35332000"]).includes("ammunition"));
});

test("email term parsing only returns labelled values", () => {
  const p = parseTermsFromText("Hello,\nUnit price: 12,50 EUR\nQuantity: 500\nLead time: 6 weeks\nPayment terms: 30 days net\nValid until 2099-01-31\n");
  assert.equal(p.unitPrice, 12.5); assert.equal(p.currency, "EUR"); assert.equal(p.quantity, 500); assert.equal(p.leadTimeDays, 42);
  assert.equal(p.paymentTerms, "30 days net"); assert.match(p.validUntil ?? "", /^2099-01-31/);
  assert.deepEqual(parseTermsFromText("Thanks for your interest, we will get back to you."), {});
});

test("taxonomy does not fire on substrings or generic words", () => {
  assert.deepEqual(classifyText("Free shipping on all orders. Visit our workspace. Fish tank accessories."), []);
  assert.ok(classifyText("Producent amunicji i celowników holograficznych").some((h) => h.key === "ammunition"));
  assert.ok(classifyText("We build warships and submarines").some((h) => h.key === "naval"));
});

test("MOQ is not mistaken for quantity; placeholder wording is not a term", () => {
  const p = parseTermsFromText("Unit price: 1180 EUR for orders of 200 pieces\nMinimum order quantity: 50 pieces\nLead time: 6 weeks\npayment and delivery terms agreed per order\nDelivery terms: agreed per order");
  assert.equal(p.moq, 50);
  assert.equal(p.quantity, undefined);
  assert.equal(p.unitPrice, 1180);
  assert.equal(p.deliveryTerms, undefined);
  assert.equal(p.paymentTerms, undefined);
});
