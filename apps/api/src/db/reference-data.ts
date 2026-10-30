import type { Db } from "./db.ts";
import type { AgentKey } from "@salespatriot/shared";

// Reference data: agent definitions, connector definitions and authority mappings.
// None of it is business data about companies or transactions.

export const AGENT_DEFINITIONS: { key: AgentKey; name: string; description: string; permissions: string[]; tools: string[] }[] = [
  { key: "event_discovery", name: "Event Discovery Agent", description: "Checks official websites of candidate European defence/industrial events and records verified event facts.", permissions: ["fetch_public_web", "write_events"], tools: ["http.fetch", "mcp.browser (optional)"] },
  { key: "event_research", name: "Event Research Agent", description: "Researches one event: official pages, exhibitor directory, documents; extracts exhibitors with provenance.", permissions: ["fetch_public_web", "write_events", "write_companies"], tools: ["http.fetch", "exhibitor.extractors", "pdf.text", "mcp.browser (optional)"] },
  { key: "event_monitoring", name: "Event Monitoring Agent", description: "Polls event sources on a schedule, diffs snapshots and records event updates.", permissions: ["fetch_public_web", "write_events"], tools: ["http.fetch", "snapshot.diff"] },
  { key: "company_identity", name: "Company Identity Agent", description: "Resolves companies against GLEIF and VIES; never merges on name similarity alone.", permissions: ["call_registries", "write_companies"], tools: ["gleif.api", "vies.api"] },
  { key: "company_discovery", name: "Company Discovery Agent", description: "Enriches companies from their official websites: products, capabilities, certifications, public contacts.", permissions: ["fetch_public_web", "write_companies"], tools: ["http.fetch", "taxonomy.classify"] },
  { key: "buyer_intelligence", name: "Buyer Intelligence Agent", description: "Synchronises real procurement notices (TED, e-Zamówienia) and classifies demand.", permissions: ["call_procurement_apis", "write_procurement"], tools: ["ted.api", "ezamowienia.api"] },
  { key: "supplier_intelligence", name: "Supplier Intelligence Agent", description: "Derives supplier capabilities from public award notices and company sources.", permissions: ["write_companies"], tools: ["procurement.awards", "taxonomy.classify"] },
  { key: "buyer_agent", name: "Buyer Agent", description: "Acts for an authorised buyer: RFQs, offer evaluation, counteroffers within the buyer's configured limits.", permissions: ["company_scoped", "negotiate_within_limits"], tools: ["negotiation.engine"] },
  { key: "supplier_agent", name: "Supplier Agent", description: "Acts for an authorised supplier: quotations and counteroffers within the supplier's configured limits.", permissions: ["company_scoped", "negotiate_within_limits"], tools: ["negotiation.engine"] },
  { key: "matching", name: "Matching Agent", description: "Builds explainable buyer–supplier matches from evidence-backed demand and capabilities.", permissions: ["write_matches"], tools: ["matching.engine"] },
  { key: "email", name: "Email Outreach Agent", description: "Drafts outreach and RFQ emails; sends only with explicit approval and a configured SMTP provider.", permissions: ["draft_email", "send_email_with_approval"], tools: ["smtp (optional)"] },
  { key: "voice", name: "Voice Calling Agent", description: "Prepares call scripts with AI disclosure; places calls only with a configured provider and approval.", permissions: ["draft_call", "place_call_with_approval"], tools: ["twilio (optional)"] },
  { key: "negotiation", name: "Negotiation Agent", description: "Runs the negotiation state machine; deterministic rules enforce authorisation limits.", permissions: ["negotiate_within_limits"], tools: ["negotiation.engine"] },
  { key: "deal_closing", name: "Deal Closing Agent", description: "Records a deal only when both parties accepted the same offer version with valid authorisation.", permissions: ["close_deal_with_authorization"], tools: ["deal.engine"] },
];

export const CONNECTOR_DEFINITIONS = [
  { key: "ted", name: "TED — Tenders Electronic Daily", kind: "procurement", status: "UNVERIFIED", endpoint: "POST https://api.ted.europa.eu/v3/notices/search", access_method: "Official API (anonymous search)", coverage_notes: "EU-wide above-threshold notices incl. Directive 2009/81/EC (defence). Primary automated source for Agencja Uzbrojenia and EDA notices.", rate_limit: "Not published; client throttles to 1 request / 1.5 s" },
  { key: "ezamowienia", name: "e-Zamówienia / BZP (Poland)", kind: "procurement", status: "UNVERIFIED", endpoint: "GET https://ezamowienia.gov.pl/mo-board/api/v1/notice", access_method: "Official API (anonymous)", coverage_notes: "Polish national notices incl. below-EU-threshold. Low-value notices often lack CPV codes and deadlines; those fields stay empty.", rate_limit: "30 requests / minute (enforced client-side)" },
  { key: "agencja_uzbrojenia", name: "Agencja Uzbrojenia (via TED)", kind: "procurement-mapping", status: "UNVERIFIED", endpoint: "TED buyer-name mapping", access_method: "Retrieved through TED", coverage_notes: "The official AU website uses CAPTCHA and is not automated. Notices are retrieved through TED only; national below-threshold AU notices may be missing.", rate_limit: null },
  { key: "eda_ted", name: "European Defence Agency (via TED)", kind: "procurement-mapping", status: "UNVERIFIED", endpoint: "TED buyer-name mapping", access_method: "Retrieved through TED", coverage_notes: "TED does not contain every EDA notice. Early / ex-ante notices may only exist on EDA's own listing.", rate_limit: null },
  { key: "eda_direct", name: "European Defence Agency — direct listing", kind: "procurement", status: "ACCESS_REQUIRED", endpoint: "https://eda.europa.eu/procurement", access_method: "Not connected (HTTP 403 in source assessment)", coverage_notes: "Direct access not established. Manual import of official EDA documents is supported.", rate_limit: null },
  { key: "nspa", name: "NATO NSPA procurement", kind: "procurement", status: "ACCESS_REQUIRED", endpoint: "NSPA hourly XML feed (documented)", access_method: "Not connected — portal redirects to login", coverage_notes: "NSPA notices are not in TED. Requires an authorised account or feed access. Legitimately obtained XML files can be imported.", rate_limit: null },
  { key: "gleif", name: "GLEIF LEI API", kind: "registry", status: "UNVERIFIED", endpoint: "GET https://api.gleif.org/api/v1/lei-records", access_method: "Official API (anonymous)", coverage_notes: "Only entities with an LEI. Responses can take 30 s+.", rate_limit: "60 requests / minute" },
  { key: "vies", name: "EU VIES VAT validation", kind: "registry", status: "UNVERIFIED", endpoint: "GET https://ec.europa.eu/taxation_customs/vies/rest-api/ms/{CC}/vat/{number}", access_method: "Official REST API", coverage_notes: "EU VAT numbers only; some member states do not return name/address.", rate_limit: "Not published; client throttles" },
  { key: "event_web", name: "Official event websites", kind: "web", status: "UNVERIFIED", endpoint: "Per-event official URLs", access_method: "Public HTML / sitemaps, robots.txt respected", coverage_notes: "JS-only directories (e.g. Eurosatory, ILA) need an authorised browser MCP; they are not scraped server-side.", rate_limit: "1 request / s per host" },
  { key: "company_web", name: "Official company websites", kind: "web", status: "UNVERIFIED", endpoint: "Per-company official URLs", access_method: "Public HTML, robots.txt respected, max 6 pages per company", coverage_notes: "Only what the company publishes. Pricing, stock and capacity are never inferred.", rate_limit: "1 request / s per host" },
  { key: "llm", name: "Anthropic Claude (extraction)", kind: "ai", status: "NOT_CONFIGURED", endpoint: "https://api.anthropic.com/v1/messages", access_method: "API key (ANTHROPIC_API_KEY)", coverage_notes: "Optional. Used only to structure existing evidence; output is schema-validated and must quote source text.", rate_limit: null },
  { key: "smtp", name: "Email (SMTP)", kind: "communication", status: "NOT_CONFIGURED", endpoint: "SMTP_HOST", access_method: "SMTP credentials", coverage_notes: "Without SMTP every email stays a draft or sandbox message.", rate_limit: null },
  { key: "twilio", name: "Voice (Twilio)", kind: "communication", status: "NOT_CONFIGURED", endpoint: "https://api.twilio.com", access_method: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN", coverage_notes: "Without credentials calls stay as reviewed scripts; no call is placed.", rate_limit: null },
] as const;

export const AUTHORITY_MAPPINGS = [
  {
    canonical_key: "AGENCJA_UZBROJENIA",
    display_name: "Agencja Uzbrojenia (Armament Agency, PL MoD)",
    match_patterns: ["agencja uzbrojenia", "inspektorat uzbrojenia"],
    ted_query: 'buyer-name ~ "Agencja Uzbrojenia" OR buyer-name ~ "Inspektorat Uzbrojenia"',
    direct_source_status: "NOT_AUTOMATED_CAPTCHA",
    coverage_note: "Retrieved through TED. The AU website (CAPTCHA) is not monitored automatically.",
  },
  {
    canonical_key: "EDA",
    display_name: "European Defence Agency",
    match_patterns: ["european defence agency", "agence européenne de défense", "europäische verteidigungsagentur"],
    ted_query: 'buyer-name ~ "European Defence Agency"',
    direct_source_status: "ACCESS_RESTRICTED_403",
    coverage_note: "Retrieved through TED; early/ex-ante EDA notices may only be on EDA's own listing (not connected).",
  },
];

/** Official event websites the Event Discovery Agent checks. Facts about each event are only taken from what these pages publish. */
export const CANDIDATE_EVENT_SOURCES = [
  { url: "https://www.targikielce.pl/en/mspo", hint: "MSPO — International Defence Industry Exhibition (Kielce)" },
  { url: "https://www.enforcetac.com/en", hint: "Enforce Tac (Nuremberg)" },
  { url: "https://www.dsei.co.uk/", hint: "DSEI (London)" },
  { url: "https://www.eurosatory.com/", hint: "Eurosatory (Paris)" },
  { url: "https://www.ila-berlin.de/en", hint: "ILA Berlin" },
  { url: "https://www.siae.fr/en/", hint: "Paris Air Show" },
  { url: "https://www.milipol.com/", hint: "Milipol Paris" },
  { url: "https://www.easa.europa.eu/en/newsroom-and-events/events", hint: "EASA events (reference)" },
  { url: "https://www.european-rotors.com/", hint: "European Rotors" },
];

export function seedReferenceData(db: Db): void {
  for (const a of AGENT_DEFINITIONS) {
    db.run(
      `INSERT INTO agents (key, name, description, permissions, tools) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, description = excluded.description, permissions = excluded.permissions, tools = excluded.tools`,
      a.key, a.name, a.description, JSON.stringify(a.permissions), JSON.stringify(a.tools),
    );
  }
  for (const c of CONNECTOR_DEFINITIONS) {
    db.run(
      `INSERT INTO connector_status (key, name, kind, status, endpoint, access_method, coverage_notes, rate_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name, kind = excluded.kind, endpoint = excluded.endpoint, access_method = excluded.access_method, coverage_notes = excluded.coverage_notes, rate_limit = excluded.rate_limit`,
      c.key, c.name, c.kind, c.status, c.endpoint, c.access_method, c.coverage_notes, c.rate_limit,
    );
  }
  for (const m of AUTHORITY_MAPPINGS) {
    db.run(
      `INSERT INTO authority_mappings (canonical_key, display_name, match_patterns, ted_query, direct_source_status, coverage_note) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(canonical_key) DO UPDATE SET display_name = excluded.display_name, match_patterns = excluded.match_patterns, ted_query = excluded.ted_query, direct_source_status = excluded.direct_source_status, coverage_note = excluded.coverage_note`,
      m.canonical_key, m.display_name, JSON.stringify(m.match_patterns), m.ted_query, m.direct_source_status, m.coverage_note,
    );
  }
}
