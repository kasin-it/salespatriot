import assert from "node:assert/strict";
import { test } from "node:test";
import { simulate, snapshotAt, type Rfq } from "../src/bidding.ts";

const rfq: Rfq = { title: "Test", buyer: "Buyer", budget: 1_000_000, currency: "EUR", targetLeadDays: 60 };

// Small deterministic LCG so a failing seed can be reproduced.
const seeded = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

test("agents never bid below their floor, and each bid beats the leader", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const sim = simulate(rfq, 5, seeded(seed));
    let best = Infinity;
    for (const e of sim.events) {
      if (e.kind === "open") best = Math.min(best, e.price!);
      if (e.kind === "bid") {
        assert.ok(e.price! < best, `seed ${seed}: bid did not beat leader`);
        assert.ok(e.price! >= sim.agents.find((a) => a.id === e.agentId)!.floor, `seed ${seed}: bid below floor`);
        best = e.price!;
      }
    }
  }
});

test("an agent only walks away once the leader is at or below its floor", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const sim = simulate(rfq, 5, seeded(seed));
    let best = Infinity;
    for (const e of sim.events) {
      if (e.kind === "open" || e.kind === "bid") best = Math.min(best, e.price!);
      if (e.kind === "drop") assert.ok(best <= sim.agents.find((a) => a.id === e.agentId)!.floor, `seed ${seed}: quit while it could still bid`);
    }
  }
});

test("every run ends with a close event and the award is the best in-budget score", () => {
  for (let seed = 1; seed <= 300; seed++) {
    const sim = simulate(rfq, 1 + (seed % 5), seeded(seed));
    assert.equal(sim.events.at(-1)!.kind, "close");
    const eligible = sim.scores.filter((s) => s.eligible);
    assert.equal(sim.winner?.agent.id, eligible.toSorted((a, b) => b.total - a.total)[0]?.agent.id);
    if (sim.winner) assert.ok(sim.winner.price <= rfq.budget);
  }
});

test("no award when no offer ends up under budget", () => {
  const sim = simulate(rfq, 1, () => 0.999);
  assert.equal(sim.winner, null);
  assert.match(sim.events.at(-1)!.text, /No offer/);
});

test("snapshot replays events into lanes and matches the final scores", () => {
  const sim = simulate(rfq, 4, seeded(7));
  assert.equal(snapshotAt(sim, 0).best, null);
  const end = snapshotAt(sim, sim.events.length);
  assert.equal(end.best, Math.min(...sim.scores.map((s) => s.price)));
  assert.equal(end.lanes.filter((l) => l.leading).length, 1);
  for (const lane of end.lanes) assert.equal(lane.price, sim.scores.find((s) => s.agent === lane.agent)!.price);
});
