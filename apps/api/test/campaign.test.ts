import { test } from "node:test";
import assert from "node:assert/strict";
import { agentAddress } from "../src/services/mailneg.ts";
import { publicRecordReply, scoreSupplier, type PublicFacts } from "../src/services/campaign.ts";
import type { StandCandidate } from "../src/services/mission.ts";

const facts: PublicFacts = { name: "Acme Optics", country: "DE", website: "https://acme.example", stand: "7-604", categories: ["Thermal imaging"], description: null, capabilities: [], certifications: [], awards: [] };
const cand = { companyId: 1, name: "Acme Optics", booth: "7-604", evidence: "", hits: ["thermal"], specificHits: [] } as unknown as StandCandidate;

test("each exhibitor gets its own agent address", () => {
  assert.equal(agentAddress("buyer"), "buyer-agent@arsenal.test");
  assert.equal(agentAddress("supplier", "AG Optics Co., Ltd."), "agent.ag-optics-co-ltd@arsenal.test");
  assert.notEqual(agentAddress("supplier", "HENSOLDT"), agentAddress("supplier", "ACTinBlack Europe"));
});

test("supplier score is evidence-based and lists what is unknown", () => {
  const s = scoreSupplier(cand, facts, false);
  assert.ok(s.score > 0 && s.score < 50);
  assert.ok(s.unknown.includes("price and lead time"));
  assert.ok(scoreSupplier(cand, facts, true).score > s.score);
});

test("public-record agent never invents attendees, price or slots", () => {
  const r = publicRecordReply(facts, { buyer: "Buyer Sp. z o.o.", supplier: "Acme Optics", event: "E", dates: null, product: "thermal cameras", quantity: 10, deadline: null, startup: false, known: [], deliveryLocation: null });
  assert.match(r.text, /Who is on site: not published/);
  assert.match(r.text, /not authorised/);
  assert.deepEqual(r.data.unknown, ["attendees", "specifications", "price and lead time", "availability"]);
});
