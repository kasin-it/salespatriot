<img src="assets/icon.svg" width="64" height="64" alt="">

# salespatriot

Created in [T3 Code](https://t3.codes).

## Development

pnpm workspace with apps in `apps/*` and shared packages in `packages/*`.

```sh
pnpm install
pnpm build      # also: dev, test, typecheck (run across packages by Turborepo)
pnpm lint       # oxlint, type-aware; lint:fix to autofix
pnpm fmt        # oxfmt; fmt:check to verify only
```

New TypeScript packages extend `@salespatriot/typescript-config/base.json`.

---

# Arsenal AI

Event-driven intelligence and marketplace for the European defence/industrial supply chain. **Real data only**: every fact carries its source URL, evidence passage, timestamps and confidence; missing information is shown as *Unknown*.

| Part | Path | Stack |
| --- | --- | --- |
| API + worker + scheduler | `apps/api` | Node 25, Hono, built-in `node:sqlite` (WAL, FTS5), zod |
| Web UI | `apps/web` | React 19, React Router, Tailwind 4, Vite |
| MCP server for Claude Desktop | `apps/mcp` | `@modelcontextprotocol/sdk` (stdio) |
| Shared vocabulary | `packages/shared` | TypeScript |

## Run

```sh
pnpm install
pnpm --filter @salespatriot/web build
pnpm --filter @salespatriot/api start        # http://127.0.0.1:8787 (serves the UI, runs the worker + scheduler)
pnpm test                                    # 37 offline tests
pnpm --filter @salespatriot/api test:live    # LIVE=1: real TED + e-Zamówienia + stdio MCP round trip
```

Config (env): `ARSENAL_DB_PATH`, `PORT`, `PROCUREMENT_AUTOSYNC=off`, `PROCUREMENT_SYNC_MINUTES`, `ARSENAL_EMBEDDED_WORKER=off` (run `pnpm --filter @salespatriot/api worker` separately), `SMTP_HOST/PORT/USER/PASS/FROM`, `TWILIO_*`, `ARSENAL_MCP_CONFIG` (Claude-Desktop-style `{ "mcpServers": {...} }` file). Secrets live only in env/config files.

## What works (verified)
- **TED** (`POST api.ted.europa.eu/v3/notices/search`): paginated, incremental by publication date, named filters, authority mapping for Agencja Uzbrojenia / EDA (retrieved *through TED*).
- **e-Zamówienia** (`GET ezamowienia.gov.pl/mo-board/api/v1/notice`): 1 request / 2.1 s (limit 30/min), missing CPV/deadline stay null, completeness score per notice.
- **Event research** extractors using public sitemaps/pages (robots.txt respected): Enforce Tac, MSPO (Targi Kielce), DSEI. Other sites yield an honest "no extractor / JS-only" result.
- Canonical company resolution (identifier > domain > exact name+country; ambiguity → NEEDS_REVIEW), GLEIF and VIES lookups, website enrichment (capability *claims* with quoted evidence).
- Task queue with retries, timeouts, approvals, cancellation, audit log; event monitoring with snapshots/diffs; matching with capped scores; negotiation state machine with backend-enforced limits; deals with audit trail; REAL vs SANDBOX separation.
- MCP: adapter/registry/permissions/execution log; `apps/mcp` exposes tools so Claude Desktop can push research (`arsenal_import_exhibitors`) back to the backend.

## Not done / external dependencies
- **NSPA**: ACCESS_REQUIRED (needs authorised account; XML schema unverified, uploads are stored raw, nothing parsed). **EDA direct** and **Agencja Uzbrojenia website**: not connected (403 / CAPTCHA); not bypassed.
- Text extraction is deterministic (taxonomy terms, regexes). **Photo reading** uses OpenAI (`OPENAI_API_KEY`, default model `gpt-4o`, override `VISION_MODEL`) or Anthropic (`ANTHROPIC_API_KEY`); verified live once against OpenAI `gpt-4o` on a generated flyer image (all fields read correctly, nothing dropped); unit tests use a fixture transport. Values the model returns that are not in its own transcription are dropped. No speech-to-text, no voice provider calls.
- **Field Agent demo path** (Mailpit): `docker run -p 1026:1025 -p 8026:8025 axllent/mailpit`, then set `SMTP_HOST=127.0.0.1 SMTP_PORT=1026 SMTP_FROM=agent@arsenal.test MAILPIT_URL=http://localhost:8026`. The agent emails a person at the event, reads the reply (photo + spec/presentation), builds a briefing and — if requested — runs the SANDBOX autopilot against a *simulated* supplier mandate and records a deal (`GET /api/deals/:id/pdf`). The supplier side is never a real company's offer.
- Exhibitor extractors for JS-only directories (Eurosatory, ILA) require an authorised browser MCP.
- Capability classification is keyword-based over public page text; treat it as *claims*, never as verified capacity, stock, price or eligibility.
- Accepted offers are recorded as `ACCEPTED_NOT_A_SIGNED_CONTRACT`; delivery/payment are not tracked.

## Demo (Mission Control)

```sh
docker run -d --name arsenal-ai-mailpit -p 1026:1025 -p 8026:8025 axllent/mailpit   # OWN mailbox, UI on :8026 (do not share 1025/8025 with other tools)
cp apps/api/.env.example apps/api/.env                       # add OPENAI_API_KEY (vision + request parsing)
pnpm install && pnpm --filter @salespatriot/web build
ARSENAL_WORKER_CONCURRENCY=10 pnpm --filter @salespatriot/api start   # http://127.0.0.1:8787
```

**Quick setup with the shared data** (instead of steps 1–2 below):
```sh
pnpm --filter @salespatriot/api seed:snapshot                         # ~1 min: 21,017 TED + e-Zamówienia rows from seed/snapshot (pulled 29–30 Oct 2026)
DEMO_PASSWORD=<any local password> pnpm --filter @salespatriot/api seed:demo   # server must be running: demo@arsenal.test, mandates, salesperson, 3 events
```
The snapshot is real public data (TED v3 API, e-Zamówienia API); each notice keeps its source link. Exhibitor profiles still load in the background after `seed:demo` (~15–20 min).

**Claude Desktop (MCP):** add `apps/mcp/src/server.ts` to `claude_desktop_config.json` with `ARSENAL_API_URL` and an `ARSENAL_API_TOKEN` from `POST /api/tokens` (scopes `read`, `write`). Use the full path to Node 24 as `command` (Desktop doesn't load nvm). Then ask Claude to source a product, or pick the `source_product` prompt.

1. Register in the UI, open **Mission Control → Setup** once (your company, buyer mandate, *simulated* supplier mandate, salesperson email).
2. Add the events (`Events → Add event by URL`, e.g. `https://www.enforcetac.com/en`, `https://www.targikielce.pl/en/mspo`). Research reads exhibitor profiles at ~1 request/s per site (~15–20 min for the full lists) — do this before the show.
3. **Scenario 1**: type the request (or click a chip) → ranking → top-3 stands → email to the salesperson → *Salesperson's phone* card (or any mail client replying to the same subject) → photo/spec parsed → briefing → buyer/supplier agents negotiate by email → **DEAL CLOSED** (PDF, ledger, human approvals: 0).
4. **Scenario 2**: pick event + stand → the agent writes "Jesteś na evencie? Sprawdź stoisko…" → same chain.
- Fallback: *Prepared reply: thermal camera / drone* sends the fixture sets in `apps/api/demo-assets/<set>/` (fictional, watermarked). Replace them with real files for a real run.
- **Drone demo**: prompt `Find me events where I can source 10 military reconnaissance drones by Q2.` — matches real TED tenders with CPV 35613000 (Unmanned aerial vehicles). Save the *Military drone mandates* profile in Setup first. Attach a photo of the real drone in the *Salesperson's phone* card.
- **Agent Bidding** (`/bidding`): pick an RFQ and press *Start bidding*. A browser-only simulated reverse auction between fictional agents with randomised prices; the buyer agent awards on price, delivery and reliability. Nothing is persisted.
- The supplier side is always a SANDBOX simulated agent with the operator's mandate; real public companies are never impersonated and the deal is not a signed contract.
