// Demo-only reverse auction. Runs entirely in the browser; bidders are fictional agents and nothing is persisted.

export type Rfq = { title: string; buyer: string; budget: number; currency: string; targetLeadDays: number };
export type Agent = { id: string; name: string; style: string; floor: number; open: number; step: number; leadDays: number; reliability: number };
export type BidEvent = { kind: "open" | "bid" | "hold" | "drop" | "round" | "close"; round: number; agentId?: string; price?: number; text: string };
export type Score = { agent: Agent; price: number; priceScore: number; leadScore: number; reliabilityScore: number; total: number; eligible: boolean };
export type Simulation = { rfq: Rfq; agents: Agent[]; events: BidEvent[]; scores: Score[]; winner: Score | null };
export type Lane = { agent: Agent; price: number | null; out: boolean; leading: boolean };
export type Snapshot = { round: number; bids: number; best: number | null; lanes: Lane[] };

export const WEIGHTS = { price: 0.6, lead: 0.25, reliability: 0.15 };
const MAX_ROUNDS = 8;
const HOLD_CHANCE = 0.15;

// Ranges are [min, max]. floor and open are fractions of the budget, lead a fraction of the target lead time.
const PROFILES = [
  { name: "Agent Kestrel", style: "Aggressive", floor: [0.72, 0.8], step: [0.03, 0.05], lead: [0.9, 1.2], reliability: [80, 90] },
  { name: "Agent Anvil", style: "Steady", floor: [0.78, 0.86], step: [0.015, 0.03], lead: [0.85, 1.1], reliability: [86, 95] },
  { name: "Agent Bastion", style: "Premium", floor: [0.84, 0.9], step: [0.01, 0.02], lead: [0.8, 0.95], reliability: [94, 99] },
  { name: "Agent Vector", style: "Fast delivery", floor: [0.8, 0.88], step: [0.015, 0.03], lead: [0.55, 0.75], reliability: [84, 92] },
  { name: "Agent Forge", style: "Volume", floor: [0.74, 0.82], step: [0.025, 0.04], lead: [1.1, 1.4], reliability: [78, 88] },
] as const;
export const MAX_AGENTS = PROFILES.length;

export const money = (n: number, currency: string) => `${Math.round(n).toLocaleString("en-GB")} ${currency}`;

const shuffled = <T,>(items: readonly T[], rng: () => number): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};

function scoreOffers(rfq: Rfq, agents: Agent[], prices: Map<string, number>): Score[] {
  const offers = agents.map((agent) => ({ agent, price: prices.get(agent.id)! }));
  const lowest = Math.min(...offers.map((o) => o.price));
  return offers
    .map(({ agent, price }) => {
      const priceScore = (lowest / price) * 100;
      const leadScore = Math.min(1, rfq.targetLeadDays / agent.leadDays) * 100;
      const total = priceScore * WEIGHTS.price + leadScore * WEIGHTS.lead + agent.reliability * WEIGHTS.reliability;
      return { agent, price, priceScore, leadScore, reliabilityScore: agent.reliability, total, eligible: price <= rfq.budget };
    })
    .toSorted((a, b) => Number(b.eligible) - Number(a.eligible) || b.total - a.total);
}

/** Plays the whole auction up front; the UI replays `events` one at a time. Pass `rng` for repeatable runs. */
export function simulate(rfq: Rfq, agentCount: number, rng: () => number = Math.random): Simulation {
  const between = ([min, max]: readonly [number, number]) => min + rng() * (max - min);
  const agents: Agent[] = shuffled(PROFILES, rng).slice(0, agentCount).map((p) => ({
    id: p.name,
    name: p.name,
    style: p.style,
    floor: Math.round(rfq.budget * between(p.floor)),
    open: Math.round(rfq.budget * between([1, 1.12])),
    step: between(p.step),
    leadDays: Math.max(1, Math.round(rfq.targetLeadDays * between(p.lead))),
    reliability: Math.round(between(p.reliability)),
  }));

  const events: BidEvent[] = [];
  const prices = new Map(agents.map((a) => [a.id, a.open]));
  const lowest = () => Math.min(...prices.values());
  for (const a of agents) events.push({ kind: "open", round: 0, agentId: a.id, price: a.open, text: `${a.name} opens at ${money(a.open, rfq.currency)}, ${a.leadDays} days` });

  let active = [...agents];
  let round = 0;
  while (active.length > 1 && round < MAX_ROUNDS) {
    round++;
    events.push({ kind: "round", round, text: `Round ${round}: ${active.length} agents still bidding` });
    for (const a of shuffled(active, rng)) {
      const best = lowest();
      if (prices.get(a.id) === best) continue; // already leading, nothing to beat
      if (rng() < HOLD_CHANCE) { events.push({ kind: "hold", round, agentId: a.id, text: `${a.name} holds this round` }); continue; }
      const bid = Math.max(a.floor, Math.round(best - rfq.budget * a.step * between([0.5, 1.5])));
      if (bid < best) {
        prices.set(a.id, bid);
        events.push({ kind: "bid", round, agentId: a.id, price: bid, text: `${a.name} undercuts to ${money(bid, rfq.currency)}` });
      } else {
        active = active.filter((x) => x !== a);
        events.push({ kind: "drop", round, agentId: a.id, text: `${a.name} walks away: it cannot beat ${money(best, rfq.currency)}` });
      }
    }
  }

  const scores = scoreOffers(rfq, agents, prices);
  const top = scores[0];
  const winner = top?.eligible ? top : null;
  events.push({
    kind: "close",
    round,
    agentId: winner?.agent.id,
    text: winner ? `Buyer agent scores all offers and awards ${winner.agent.name}` : "No offer came in under budget, so the buyer agent makes no award",
  });
  return { rfq, agents, events, scores, winner };
}

/** Auction state after the first `shown` events. */
export function snapshotAt(sim: Simulation, shown: number): Snapshot {
  const prices = new Map<string, number>();
  const out = new Set<string>();
  let round = 0;
  let bids = 0;
  for (const e of sim.events.slice(0, shown)) {
    round = e.round;
    if ((e.kind === "open" || e.kind === "bid") && e.agentId && e.price != null) { prices.set(e.agentId, e.price); bids++; }
    if (e.kind === "drop" && e.agentId) out.add(e.agentId);
  }
  const best = prices.size ? Math.min(...prices.values()) : null;
  const lanes = sim.agents.map((agent) => {
    const price = prices.get(agent.id) ?? null;
    return { agent, price, out: out.has(agent.id), leading: price != null && price === best };
  });
  return { round, bids, best, lanes };
}
