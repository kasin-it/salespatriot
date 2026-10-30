import { useEffect, useState } from "react";
import { useApi } from "../api.ts";
import { Badge, Btn, Card, Err, Field, Marker, Notice, PageHead, Stat, Table, Unknown } from "../ui.tsx";
import { MAX_AGENTS, WEIGHTS, money, simulate, snapshotAt, type BidEvent, type Lane, type Rfq, type Simulation } from "../bidding.ts";
import type { Row } from "../types.ts";

const TICK_MS = 650;
const DEFAULT_BUDGET = 1_000_000;

const PRESETS: Rfq[] = [
  { title: "10 military reconnaissance drones, delivery by Q2", buyer: "Demo buyer", budget: 2_400_000, currency: "EUR", targetLeadDays: 90 },
  { title: "40 thermal imaging cameras for border patrol vehicles", buyer: "Demo buyer", budget: 680_000, currency: "EUR", targetLeadDays: 60 },
  { title: "250 encrypted tactical radios with spares", buyer: "Demo buyer", budget: 1_150_000, currency: "EUR", targetLeadDays: 120 },
];

const rfqFromNotice = (n: Row): Rfq => ({
  title: n.title ?? `Notice ${n.source_notice_id}`,
  buyer: n.contracting_authority ?? "Authority unknown",
  budget: n.estimated_value > 0 ? Math.round(n.estimated_value) : DEFAULT_BUDGET,
  currency: n.currency ?? "EUR",
  targetLeadDays: 90,
});

const laneStatus = (lane: Lane, finished: boolean, sim: Simulation) => {
  if (finished && sim.winner?.agent === lane.agent) return <Badge value="WINNER" tone="green" />;
  if (lane.out) return <Badge value="WALKED AWAY" tone="grey" />;
  if (lane.leading) return <Badge value="LEADING" tone="blue" />;
  return <Badge value={lane.price == null ? "WAITING" : "BIDDING"} tone="amber" />;
};

const logTone = (e: BidEvent) => (e.kind === "drop" ? "wait" : e.kind === "bid" || e.kind === "close" ? "active" : "ok");

function BidLanes({ sim, lanes, finished }: { sim: Simulation; lanes: Lane[]; finished: boolean }) {
  const scale = Math.max(sim.rfq.budget, ...sim.agents.map((a) => a.open));
  const sorted = lanes.toSorted((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  return (
    <div className="space-y-3">
      {sorted.map((lane) => (
        <div key={lane.agent.id} className={lane.out ? "opacity-60" : ""}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span><span className="font-medium">{lane.agent.name}</span> <span className="text-muted">· {lane.agent.style} · {lane.agent.leadDays} days · {lane.agent.reliability}% reliable</span></span>
            <span className="flex items-center gap-2"><span className="font-mono font-medium tabular-nums">{lane.price == null ? "—" : money(lane.price, sim.rfq.currency)}</span>{laneStatus(lane, finished, sim)}</span>
          </div>
          <div className="relative mt-1 h-2 bg-fill" title={lane.price == null ? "No bid yet" : `${lane.agent.name}: ${money(lane.price, sim.rfq.currency)}`}>
            <div className={`h-full transition-[width] duration-500 ${lane.leading ? "bg-accent" : "bg-faint"}`} style={{ width: `${((lane.price ?? 0) / scale) * 100}%` }} />
            {/* The budget line, so bids visibly cross under it. */}
            <div className="absolute inset-y-[-2px] w-0.5 bg-ink" style={{ left: `${(sim.rfq.budget / scale) * 100}%` }} />
          </div>
          {finished && <div className="mt-1 text-[11px] text-muted">Hidden walk-away price: {money(lane.agent.floor, sim.rfq.currency)}</div>}
        </div>
      ))}
      <div className="flex items-center gap-2 text-[11px] text-muted"><span className="inline-block h-3 w-0.5 bg-ink" />Budget {money(sim.rfq.budget, sim.rfq.currency)}</div>
    </div>
  );
}

function Resolution({ sim }: { sim: Simulation }) {
  const { rfq, winner, scores } = sim;
  const cheapest = scores.reduce((a, b) => (b.price < a.price ? b : a));
  const under = winner ? ((rfq.budget - winner.price) / rfq.budget) * 100 : 0;
  return (
    <div className="space-y-5">
      {winner
        ? <div className="ds-banner ds-banner--accent">Awarded: {winner.agent.name} · {money(winner.price, rfq.currency)} · {under.toFixed(1)}% under budget · human approvals: 0</div>
        : <div className="ds-banner">No award · no offer under budget</div>}
      <Card title="How the buyer agent resolved it">
        <p className="m-0 mb-3 text-sm text-muted">
          Score = {WEIGHTS.price * 100}% price + {WEIGHTS.lead * 100}% delivery + {WEIGHTS.reliability * 100}% reliability. Offers above budget cannot win.
          {winner && winner !== cheapest && <> {cheapest.agent.name} had the lowest price, but {winner.agent.name} scored higher overall.</>}
        </p>
        <Table rows={scores} cols={[
          { h: "Agent", r: (s) => <span className="font-medium">{s.agent.name}</span> },
          { h: "Final offer", r: (s) => <span className="font-mono tabular-nums">{money(s.price, rfq.currency)}</span> },
          { h: "Price", r: (s) => s.priceScore.toFixed(1) },
          { h: "Delivery", r: (s) => s.leadScore.toFixed(1) },
          { h: "Reliability", r: (s) => s.reliabilityScore.toFixed(1) },
          { h: "Total", r: (s) => <span className="font-medium">{s.total.toFixed(1)}</span> },
          { h: "Outcome", r: (s) => (s === winner ? <Badge value="WINNER" tone="green" /> : s.eligible ? <Badge value="RUNNER UP" tone="grey" /> : <Badge value="OVER BUDGET" tone="grey" />) },
        ]} />
      </Card>
    </div>
  );
}

export function Bidding() {
  const notices = useApi<Row>("/procurement?limit=50");
  const rows = (notices.data?.rows ?? []) as Row[];
  const [choice, setChoice] = useState("preset:0");
  const [rfq, setRfq] = useState<Rfq>(PRESETS[0]!);
  const [agentCount, setAgentCount] = useState(4);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [shown, setShown] = useState(0);
  const [playing, setPlaying] = useState(false);

  const total = sim?.events.length ?? 0;
  const finished = sim !== null && shown >= total;

  useEffect(() => {
    if (playing && shown >= total) setPlaying(false);
    const id = playing && shown < total ? setTimeout(() => setShown((n) => n + 1), TICK_MS) : undefined;
    return () => clearTimeout(id);
  }, [playing, shown, total]);

  const reset = () => { setSim(null); setShown(0); setPlaying(false); };
  const pick = (value: string) => {
    const [kind, id] = value.split(":");
    const next = kind === "notice" ? rows.find((n) => String(n.id) === id) : null;
    setChoice(value);
    setRfq(next ? rfqFromNotice(next) : PRESETS[Number(id)]!);
    reset();
  };
  const edit = (patch: Partial<Rfq>) => { setRfq({ ...rfq, ...patch }); reset(); };
  const start = () => { setSim(simulate(rfq, agentCount)); setShown(1); setPlaying(true); };

  const snap = sim ? snapshotAt(sim, shown) : null;
  const valid = rfq.budget > 0 && rfq.targetLeadDays > 0;
  const saved = snap?.best != null ? ((rfq.budget - snap.best) / rfq.budget) * 100 : null;

  return (
    <div className="space-y-5">
      <PageHead title="Agent Bidding" sub="Supplier agents compete on an RFQ. The buyer agent resolves it without a human." actions={<Badge value="SANDBOX" />} />
      <Notice tone="warn">SIMULATION: the bidders are fictional agents with randomised prices. No real company is bidding, and nothing here is recorded as a deal.</Notice>
      <Err msg={notices.error} />
      <Card title="RFQ" actions={
        <>
          {sim && !finished && <Btn onClick={() => setPlaying(!playing)}>{playing ? "Pause" : "Resume"}</Btn>}
          {sim && !finished && <Btn onClick={() => { setShown(total); setPlaying(false); }}>Skip to result</Btn>}
          <Btn tone="primary" disabled={!valid || playing} onClick={start}>{sim ? "Run again" : "Start bidding"}</Btn>
        </>
      }>
        <div className="grid gap-3 md:grid-cols-6">
          <div className="md:col-span-3"><Field label="RFQ"><select value={choice} onChange={(e) => pick(e.target.value)}>
            <optgroup label="Demo RFQs">{PRESETS.map((p, i) => <option key={p.title} value={`preset:${i}`}>{p.title}</option>)}</optgroup>
            {rows.length > 0 && <optgroup label="Stored notices">{rows.map((n) => <option key={n.id} value={`notice:${n.id}`}>{(n.title ?? `Notice ${n.source_notice_id}`).slice(0, 90)}</option>)}</optgroup>}
          </select></Field></div>
          <Field label={`Budget (${rfq.currency})`}><input type="number" min="1" value={rfq.budget || ""} onChange={(e) => edit({ budget: Number(e.target.value) })} /></Field>
          <Field label="Target lead time (days)"><input type="number" min="1" value={rfq.targetLeadDays || ""} onChange={(e) => edit({ targetLeadDays: Number(e.target.value) })} /></Field>
          <Field label="Agents"><select value={agentCount} onChange={(e) => { setAgentCount(Number(e.target.value)); reset(); }}>{Array.from({ length: MAX_AGENTS - 1 }, (_, i) => i + 2).map((n) => <option key={n} value={n}>{n}</option>)}</select></Field>
        </div>
        <div className="mt-2 text-xs text-muted">Buyer: {rfq.buyer}</div>
      </Card>

      {sim && snap && (
        <>
          <div className="grid gap-3 md:grid-cols-4">
            <Stat label="Round" value={snap.round} />
            <Stat label="Best bid" value={snap.best == null ? <Unknown label="—" /> : snap.best.toLocaleString("en-GB", { notation: "compact", maximumFractionDigits: 2 })} sub={rfq.currency} />
            <Stat label="Against budget" value={saved == null ? <Unknown label="—" /> : `${saved >= 0 ? "-" : "+"}${Math.abs(saved).toFixed(1)}%`} />
            <Stat label="Bids placed" value={snap.bids} />
          </div>
          <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
            <Card title="Live bids (lowest first)"><BidLanes sim={sim} lanes={snap.lanes} finished={finished} /></Card>
            <Card title="Agent activity">
              <ol className="m-0 max-h-80 list-none space-y-1.5 overflow-y-auto p-0 text-[13px]">
                {sim.events.slice(0, shown).toReversed().map((e) => (
                  <li key={sim.events.indexOf(e)} className="flex items-baseline gap-2"><Marker tone={logTone(e)} /><span className={e.kind === "round" ? "ds-cap" : ""}>{e.text}</span></li>
                ))}
              </ol>
            </Card>
          </div>
          {finished && <Resolution sim={sim} />}
        </>
      )}
    </div>
  );
}
