import { test } from "node:test";
import assert from "node:assert/strict";
import { extractFromImage, visionProvider } from "../src/services/vision.ts";

// FIXTURE transports stand in for the provider APIs; no real model is called in these tests.
const visible = ["Thermal camera TI-640", "Unit price: 1200 EUR", "Lead time: 6 weeks", "ISO 9001"];
const out = { readable: true, visible_text: visible, product_name: "Thermal camera TI-640", unit_price: "1200 EUR", lead_time: "6 weeks", certifications: ["ISO 9001", "MIL-STD-810"], specs: [{ name: "Unit price", value: "1200 EUR" }, { name: "Range", value: "5 km" }] };
const openaiTransport = (calls: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> }) => async (url: string, init: { headers: Record<string, string>; body: string }) => {
  calls.url = url; calls.headers = init.headers; calls.body = JSON.parse(init.body);
  return { ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { tool_calls: [{ function: { arguments: JSON.stringify(out) } }] } }] }) };
};

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const old: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return fn().finally(() => { for (const k of Object.keys(old)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; } });
}

test("provider selection: OpenAI key wins, none means not configured", async () => {
  await withEnv({ OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "a", VISION_PROVIDER: undefined }, async () => assert.equal(visionProvider(), "openai"));
  await withEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: undefined, VISION_PROVIDER: undefined }, async () => assert.equal(visionProvider(), "anthropic"));
  await withEnv({ OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined, VISION_PROVIDER: undefined }, async () => {
    assert.equal(visionProvider(), null);
    await assert.rejects(extractFromImage(new Uint8Array([1]), "image/jpeg"), /VISION_NOT_CONFIGURED/);
  });
});

test("OpenAI request shape and anti-hallucination guard: values absent from the transcription are dropped", async () => {
  const calls: { url?: string; body?: Record<string, unknown>; headers?: Record<string, string> } = {};
  const r = await withEnv({ OPENAI_API_KEY: "test-key", VISION_PROVIDER: undefined, VISION_MODEL: undefined, OPENAI_BASE_URL: undefined }, () => extractFromImage(new Uint8Array([0xff, 0xd8, 1]), "image/jpeg", openaiTransport(calls)));
  assert.equal(calls.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(calls.headers?.authorization, "Bearer test-key");
  assert.equal(calls.body?.model, "gpt-4o");
  assert.match(JSON.stringify(calls.body), /data:image\/jpeg;base64,/);
  assert.equal(r.unit_price, "1200 EUR");
  assert.deepEqual(r.certifications, ["ISO 9001"], "MIL-STD-810 was never visible, so it must be dropped");
  assert.deepEqual(r.specs.map((s) => s.name), ["Unit price"], "Range 5 km was never visible");
  assert.equal(r.dropped.length, 2);
});

test("bad model output and HTTP errors are surfaced, not swallowed", async () => {
  await withEnv({ OPENAI_API_KEY: "k", VISION_PROVIDER: undefined }, async () => {
    await assert.rejects(extractFromImage(new Uint8Array([1]), "image/png", async () => ({ ok: true, status: 200, text: async () => "", json: async () => ({ choices: [{ message: { content: "sure!" } }] }) })), /VISION_BAD_OUTPUT/);
    await assert.rejects(extractFromImage(new Uint8Array([1]), "image/png", async () => ({ ok: false, status: 401, text: async () => "bad key", json: async () => ({}) })), /VISION_API_ERROR openai 401/);
    await assert.rejects(extractFromImage(new Uint8Array([1]), "application/pdf"), /UNSUPPORTED_IMAGE_TYPE/);
  });
});

import { simplePdf } from "../src/lib/pdf.ts";
import { extractText, getDocumentProxy } from "unpdf";
test("deal PDF is a valid document whose text round-trips", async () => {
  const doc = await getDocumentProxy(simplePdf(["DEAL RECORD SBX-1", "SANDBOX - SIMULATION", "Zażółć (test)"]));
  const r = await extractText(doc, { mergePages: true });
  const text = Array.isArray(r.text) ? r.text.join(" ") : r.text;
  assert.match(text, /DEAL RECORD SBX-1/); assert.match(text, /SANDBOX - SIMULATION/);
});

import { parseRequest } from "../src/services/mission.ts";
test("request parsing: rules map thermal cameras to optics, quantity and quarter deadline are literal", async () => {
  const saved = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  try {
    const p = await parseRequest("Find me events where I can source 200 thermal cameras by Q1.");
    assert.equal(p.categoryKey, "optics_sights");
    assert.equal(p.quantity, 200);
    assert.match(p.deadline ?? "", /^20\d\d-03-31$/);
    assert.ok(!/^\d/.test(p.product), `product "${p.product}" must not start with the quantity`);
    assert.equal((await parseRequest("Find me events with bakery equipment please")).categoryKey, null);
  } finally { if (saved) process.env.OPENAI_API_KEY = saved; }
});

import { specificTokens } from "../src/services/mission.ts";
test("specific tokens come from the product modifiers", () => {
  assert.deepEqual(specificTokens("thermal cameras"), ["thermal"]);
  assert.deepEqual(specificTokens("night vision goggles"), ["night", "vision"]);
  assert.deepEqual(specificTokens("radios"), ["radio"]);
});

import { freshDb } from "./helpers.ts";
import { demandForCategory } from "../src/services/demand.ts";
import { storeNotice } from "../src/services/procurement-store.ts";
import { parseTedNotice } from "../src/connectors/ted.ts";

test("demand: a notice naming the product in its title outranks a CPV mention; awards are separated from open demand", () => {
  freshDb();
  const base = { "notice-type": "cn-standard", "buyer-name": { eng: ["Ministry"] }, "buyer-country": ["POL"], "publication-date": "2099-01-01+01:00", links: { html: { ENG: "u" } } };
  // FIXTURE notices (test only)
  storeNotice({ ...parseTedNotice({ ...base, "publication-number": "1-2099", "notice-title": { eng: "Poland – Unmanned aerial vehicles – Reconnaissance drones" }, "classification-cpv": ["35613000"] })!, deadline: "2099-12-31T00:00:00" });
  storeNotice({ ...parseTedNotice({ ...base, "publication-number": "2-2099", "notice-title": { eng: "Poland – Military aircraft – maintenance" }, "classification-cpv": ["35613000", "50000000"] })!, deadline: "2099-12-31T00:00:00" });
  storeNotice({ ...parseTedNotice({ ...base, "publication-number": "3-2099", "notice-type": "can-standard", "notice-title": { eng: "Czechia – Unmanned aerial vehicles – purchase" }, "classification-cpv": ["35613000"] })! });
  storeNotice({ ...parseTedNotice({ ...base, "publication-number": "4-2099", "notice-title": { eng: "Poland – Canteen supplies" }, "classification-cpv": ["15000000"] })!, deadline: "2099-12-31T00:00:00" });
  const d = demandForCategory("uav_drones", { specific: ["military"] });
  assert.deepEqual(d.open.map((n) => n.title?.includes("Unmanned")), [true, false]);
  assert.equal(d.totals.open, 2);
  assert.equal(d.awards.length, 1);
  assert.equal(d.awards[0]!.demandClass, "HISTORICAL_DEMAND");
});
