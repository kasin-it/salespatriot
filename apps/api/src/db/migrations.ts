// Ordered, append-only migrations. Never edit a migration that has shipped; add a new one.

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

const ts = "TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const migrations: Migration[] = [
  {
    id: 1,
    name: "core",
    sql: `
-- Identity & tenancy -------------------------------------------------------
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at ${ts}
);
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at ${ts}
);

-- Sources & provenance ------------------------------------------------------
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL UNIQUE,
  domain TEXT,
  source_type TEXT NOT NULL,
  title TEXT,
  robots_allowed INTEGER,
  last_fetched_at TEXT,
  last_http_status INTEGER,
  last_error TEXT,
  content_hash TEXT,
  created_at ${ts}
);
CREATE TABLE source_snapshots (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fetched_at ${ts},
  http_status INTEGER,
  content_type TEXT,
  content_hash TEXT,
  byte_size INTEGER,
  body TEXT
);
CREATE INDEX idx_snapshots_source ON source_snapshots(source_id, fetched_at);
CREATE TABLE scraping_jobs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  task_id INTEGER,
  status TEXT NOT NULL,
  http_status INTEGER,
  duration_ms INTEGER,
  from_cache INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at ${ts}
);
CREATE INDEX idx_scraping_jobs_created ON scraping_jobs(created_at);

-- Generic fact store. Multiple sources may assert the same field; conflicts are kept, never overwritten.
CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  field_value TEXT,
  source_id INTEGER REFERENCES sources(id),
  source_url TEXT,
  source_type TEXT NOT NULL,
  fact_kind TEXT NOT NULL,
  evidence_text TEXT,
  collected_at ${ts},
  last_verified_at TEXT,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  valid_until TEXT,
  superseded_by INTEGER REFERENCES facts(id),
  created_by_user_id INTEGER REFERENCES users(id),
  UNIQUE(entity_type, entity_id, field_name, field_value, source_url)
);
CREATE INDEX idx_facts_entity ON facts(entity_type, entity_id, field_name);
CREATE VIEW company_facts AS SELECT id, entity_id AS company_id, field_name, field_value, source_id, source_url, source_type, fact_kind, evidence_text, collected_at, last_verified_at, confidence, verification_status, valid_until FROM facts WHERE entity_type = 'company';
CREATE VIEW event_facts AS SELECT id, entity_id AS event_id, field_name, field_value, source_id, source_url, source_type, fact_kind, evidence_text, collected_at, last_verified_at, confidence, verification_status, valid_until FROM facts WHERE entity_type = 'event';

-- Companies -----------------------------------------------------------------
CREATE TABLE companies (
  id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  legal_name TEXT,
  trading_name TEXT,
  country TEXT,
  website TEXT,
  website_domain TEXT,
  description TEXT,
  description_source_url TEXT,
  identity_state TEXT NOT NULL DEFAULT 'UNVERIFIED',
  is_registered INTEGER NOT NULL DEFAULT 0,
  parent_company_id INTEGER REFERENCES companies(id),
  origin TEXT NOT NULL,
  enrichment_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  last_enriched_at TEXT,
  created_at ${ts},
  updated_at ${ts}
);
CREATE INDEX idx_companies_norm ON companies(normalized_name, country);
CREATE UNIQUE INDEX idx_companies_domain ON companies(website_domain) WHERE website_domain IS NOT NULL;
CREATE TABLE company_identifiers (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  source_url TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verified_at TEXT,
  created_at ${ts},
  UNIQUE(scheme, value)
);
CREATE TABLE company_aliases (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized TEXT NOT NULL,
  source_url TEXT,
  UNIQUE(company_id, normalized)
);
CREATE INDEX idx_aliases_norm ON company_aliases(normalized);
CREATE TABLE company_memberships (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  job_title TEXT,
  authorization_level TEXT NOT NULL,
  email_domain_verified INTEGER NOT NULL DEFAULT 0,
  created_at ${ts},
  PRIMARY KEY (user_id, company_id)
);
CREATE TABLE company_products (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category_key TEXT,
  description TEXT,
  source_url TEXT,
  source_type TEXT NOT NULL,
  fact_kind TEXT NOT NULL,
  evidence_text TEXT,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  collected_at ${ts},
  UNIQUE(company_id, name, source_url)
);
CREATE TABLE company_capabilities (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  category_key TEXT NOT NULL,
  label TEXT NOT NULL,
  capability_class TEXT NOT NULL,
  source_url TEXT,
  source_type TEXT NOT NULL,
  evidence_text TEXT,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  collected_at ${ts},
  UNIQUE(company_id, category_key, source_url)
);
CREATE INDEX idx_caps_category ON company_capabilities(category_key);
CREATE TABLE company_certifications (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  fact_kind TEXT NOT NULL,
  source_url TEXT,
  evidence_text TEXT,
  confidence REAL NOT NULL,
  verification_status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  collected_at ${ts},
  UNIQUE(company_id, name, source_url)
);
CREATE TABLE company_contacts (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT,
  source_url TEXT,
  evidence_text TEXT,
  is_public INTEGER NOT NULL DEFAULT 1,
  authorized_for_outreach INTEGER NOT NULL DEFAULT 0,
  collected_at ${ts},
  UNIQUE(company_id, kind, value)
);
CREATE TABLE company_relationships (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  related_company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  source_url TEXT,
  evidence_text TEXT,
  fact_kind TEXT NOT NULL,
  collected_at ${ts},
  UNIQUE(company_id, related_company_id, relation)
);

-- Events --------------------------------------------------------------------
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  edition TEXT,
  official_url TEXT NOT NULL UNIQUE,
  organizer TEXT,
  city TEXT,
  country TEXT,
  venue TEXT,
  start_date TEXT,
  end_date TEXT,
  dates_evidence TEXT,
  dates_source_url TEXT,
  description TEXT,
  exhibitor_directory_url TEXT,
  exhibitor_strategy TEXT,
  relevance_score REAL,
  relevance_reasons TEXT,
  research_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  discovered_via TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id),
  last_researched_at TEXT,
  created_at ${ts},
  updated_at ${ts}
);
CREATE TABLE event_categories (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  evidence_text TEXT,
  PRIMARY KEY (event_id, category)
);
CREATE TABLE event_sources (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (event_id, source_id, role)
);
CREATE TABLE event_snapshots (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES sources(id),
  content_hash TEXT,
  exhibitor_count INTEGER,
  exhibitor_hash TEXT,
  taken_at ${ts}
);
CREATE TABLE event_updates (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  source_url TEXT,
  detected_at ${ts}
);
CREATE INDEX idx_event_updates_event ON event_updates(event_id, detected_at);
CREATE TABLE event_exhibitors (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id),
  external_id TEXT,
  exhibitor_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  country TEXT,
  city TEXT,
  website TEXT,
  booth TEXT,
  description TEXT,
  categories TEXT,
  profile_url TEXT,
  source_url TEXT NOT NULL,
  evidence_text TEXT,
  detail_fetched_at TEXT,
  resolution_status TEXT NOT NULL DEFAULT 'PENDING',
  first_seen_at ${ts},
  last_seen_at ${ts},
  removed_at TEXT,
  UNIQUE(event_id, normalized_name)
);
CREATE INDEX idx_exhibitors_company ON event_exhibitors(company_id);
CREATE VIEW company_events AS SELECT company_id, event_id, id AS exhibitor_id, booth, first_seen_at, removed_at FROM event_exhibitors WHERE company_id IS NOT NULL;
CREATE TABLE event_documents (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  title TEXT,
  doc_type TEXT,
  text_excerpt TEXT,
  discovered_at ${ts},
  UNIQUE(event_id, url)
);
CREATE TABLE event_agendas (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  starts_at TEXT,
  speakers TEXT,
  source_url TEXT,
  evidence_text TEXT,
  UNIQUE(event_id, title, starts_at)
);
CREATE TABLE event_monitoring_jobs (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  interval_minutes INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  changes_detected INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT
);

-- Procurement ---------------------------------------------------------------
CREATE TABLE procurement_notices (
  id INTEGER PRIMARY KEY,
  source_key TEXT NOT NULL,
  retrieved_via TEXT NOT NULL,
  source_notice_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  publication_date TEXT,
  retrieval_timestamp ${ts},
  original_payload TEXT,
  contracting_authority TEXT,
  authority_national_id TEXT,
  authority_company_id INTEGER REFERENCES companies(id),
  authority_tags TEXT NOT NULL DEFAULT '[]',
  title TEXT,
  description TEXT,
  cpv_codes TEXT NOT NULL DEFAULT '[]',
  deadline TEXT,
  estimated_value REAL,
  currency TEXT,
  lots TEXT NOT NULL DEFAULT '[]',
  technical_requirements TEXT,
  notice_type TEXT,
  procurement_status TEXT,
  legal_basis TEXT,
  contract_nature TEXT,
  country TEXT,
  awarded_suppliers TEXT NOT NULL DEFAULT '[]',
  data_completeness REAL NOT NULL,
  missing_fields TEXT NOT NULL DEFAULT '[]',
  verification_status TEXT NOT NULL DEFAULT 'VERIFIED',
  demand_class TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  first_seen_at ${ts},
  updated_at ${ts},
  UNIQUE(source_key, source_notice_id)
);
CREATE INDEX idx_notices_pub ON procurement_notices(publication_date);
CREATE INDEX idx_notices_deadline ON procurement_notices(deadline);
CREATE TABLE authority_mappings (
  id INTEGER PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  match_patterns TEXT NOT NULL,
  ted_query TEXT,
  direct_source_status TEXT NOT NULL,
  coverage_note TEXT NOT NULL
);

-- Marketplace (tenant-private) ---------------------------------------------
CREATE TABLE buyer_requirements (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category_keys TEXT NOT NULL DEFAULT '[]',
  cpv_codes TEXT NOT NULL DEFAULT '[]',
  quantity REAL,
  unit TEXT,
  currency TEXT,
  delivery_location TEXT,
  needed_by TEXT,
  certifications_required TEXT NOT NULL DEFAULT '[]',
  demand_class TEXT NOT NULL,
  procurement_notice_id INTEGER REFERENCES procurement_notices(id),
  origin_event_id INTEGER REFERENCES events(id),
  status TEXT NOT NULL DEFAULT 'OPEN',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at ${ts}
);
CREATE TABLE supplier_offerings (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category_keys TEXT NOT NULL DEFAULT '[]',
  cpv_codes TEXT NOT NULL DEFAULT '[]',
  currency TEXT,
  moq REAL,
  lead_time_days INTEGER,
  certifications TEXT NOT NULL DEFAULT '[]',
  capability_id INTEGER REFERENCES company_capabilities(id),
  confirmed_by_company INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_by_user_id INTEGER REFERENCES users(id),
  created_at ${ts}
);
CREATE TABLE matches (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  match_key TEXT NOT NULL UNIQUE,
  buyer_company_id INTEGER REFERENCES companies(id),
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id),
  procurement_notice_id INTEGER REFERENCES procurement_notices(id),
  buyer_requirement_id INTEGER REFERENCES buyer_requirements(id),
  supplier_offering_id INTEGER REFERENCES supplier_offerings(id),
  origin_event_id INTEGER REFERENCES events(id),
  category_keys TEXT NOT NULL,
  score REAL NOT NULL,
  status TEXT NOT NULL,
  demand_class TEXT,
  explanation TEXT NOT NULL,
  evidence TEXT NOT NULL,
  missing_info TEXT NOT NULL,
  risks TEXT NOT NULL,
  confidence REAL NOT NULL,
  visible_to_company_id INTEGER REFERENCES companies(id),
  created_at ${ts},
  updated_at ${ts}
);
CREATE INDEX idx_matches_supplier ON matches(supplier_company_id);
CREATE INDEX idx_matches_notice ON matches(procurement_notice_id);

-- Negotiation & deals -------------------------------------------------------
CREATE TABLE negotiation_policies (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  side TEXT NOT NULL,
  currency TEXT,
  max_unit_price REAL,
  min_unit_price REAL,
  max_quantity REAL,
  min_quantity REAL,
  max_discount_pct REAL,
  allowed_payment_terms TEXT,
  max_lead_time_days INTEGER,
  max_rounds INTEGER,
  autonomous_accept INTEGER NOT NULL DEFAULT 0,
  approval_required_above_total REAL,
  updated_by_user_id INTEGER REFERENCES users(id),
  updated_at ${ts},
  UNIQUE(company_id, side)
);
CREATE TABLE negotiations (
  id INTEGER PRIMARY KEY,
  mode TEXT NOT NULL,
  buyer_company_id INTEGER NOT NULL REFERENCES companies(id),
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id),
  buyer_requirement_id INTEGER REFERENCES buyer_requirements(id),
  supplier_offering_id INTEGER REFERENCES supplier_offerings(id),
  match_id INTEGER REFERENCES matches(id),
  origin_event_id INTEGER REFERENCES events(id),
  subject TEXT NOT NULL,
  state TEXT NOT NULL,
  round INTEGER NOT NULL DEFAULT 0,
  current_offer_id INTEGER,
  buyer_policy_snapshot TEXT,
  supplier_policy_snapshot TEXT,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at ${ts},
  updated_at ${ts}
);
CREATE TABLE negotiation_transitions (
  id INTEGER PRIMARY KEY,
  negotiation_id INTEGER NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at ${ts}
);
CREATE TABLE rfqs (
  id INTEGER PRIMARY KEY,
  negotiation_id INTEGER NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  buyer_company_id INTEGER NOT NULL REFERENCES companies(id),
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id),
  requested_terms TEXT NOT NULL,
  body TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at ${ts}
);
CREATE TABLE offers (
  id INTEGER PRIMARY KEY,
  negotiation_id INTEGER NOT NULL REFERENCES negotiations(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  previous_offer_id INTEGER REFERENCES offers(id),
  kind TEXT NOT NULL,
  from_company_id INTEGER NOT NULL REFERENCES companies(id),
  to_company_id INTEGER NOT NULL REFERENCES companies(id),
  terms TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  origin TEXT NOT NULL,
  rationale TEXT,
  created_by TEXT NOT NULL,
  created_at ${ts},
  UNIQUE(negotiation_id, version)
);
CREATE VIEW offer_versions AS SELECT id, negotiation_id, version, previous_offer_id, kind, from_company_id, terms, status, created_at FROM offers;
CREATE TABLE quotations (
  id INTEGER PRIMARY KEY,
  rfq_id INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id),
  mode TEXT NOT NULL,
  received_at ${ts}
);
CREATE TABLE offer_acceptances (
  id INTEGER PRIMARY KEY,
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  accepted_by TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  authorization_basis TEXT NOT NULL,
  accepted_at ${ts},
  UNIQUE(offer_id, company_id)
);
CREATE TABLE approvals (
  id INTEGER PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  payload TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  requested_by TEXT NOT NULL,
  decided_by_user_id INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at ${ts}
);
CREATE TABLE deals (
  id INTEGER PRIMARY KEY,
  deal_ref TEXT NOT NULL UNIQUE,
  negotiation_id INTEGER NOT NULL UNIQUE REFERENCES negotiations(id),
  offer_id INTEGER NOT NULL REFERENCES offers(id),
  buyer_company_id INTEGER NOT NULL REFERENCES companies(id),
  supplier_company_id INTEGER NOT NULL REFERENCES companies(id),
  origin_event_id INTEGER REFERENCES events(id),
  subject TEXT NOT NULL,
  terms TEXT NOT NULL,
  total_value REAL,
  currency TEXT,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  accepted_at ${ts}
);
CREATE TABLE deal_events (
  id INTEGER PRIMARY KEY,
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload TEXT,
  actor TEXT NOT NULL,
  created_at ${ts}
);

-- Communication -------------------------------------------------------------
CREATE TABLE conversations (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  counterparty_company_id INTEGER REFERENCES companies(id),
  negotiation_id INTEGER REFERENCES negotiations(id),
  channel TEXT NOT NULL,
  subject TEXT,
  created_at ${ts}
);
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  structured TEXT,
  created_at ${ts}
);
CREATE TABLE email_messages (
  id INTEGER PRIMARY KEY,
  conversation_id INTEGER REFERENCES conversations(id),
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER REFERENCES company_contacts(id),
  direction TEXT NOT NULL,
  to_address TEXT,
  from_address TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  mode TEXT NOT NULL,
  provider TEXT,
  provider_message_id TEXT,
  parsed_terms TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at ${ts},
  sent_at TEXT
);
CREATE TABLE voice_calls (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  contact_id INTEGER REFERENCES company_contacts(id),
  to_number TEXT,
  purpose TEXT NOT NULL,
  script TEXT NOT NULL,
  ai_disclosure TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT,
  provider_call_id TEXT,
  summary TEXT,
  error TEXT,
  created_by TEXT NOT NULL,
  created_at ${ts}
);

-- Agents & orchestration ----------------------------------------------------
CREATE TABLE agents (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  permissions TEXT NOT NULL,
  tools TEXT NOT NULL,
  last_activity_at TEXT
);
CREATE TABLE agent_permissions (
  id INTEGER PRIMARY KEY,
  agent_key TEXT NOT NULL REFERENCES agents(key),
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  granted_by_user_id INTEGER REFERENCES users(id),
  granted_at ${ts},
  UNIQUE(agent_key, company_id, permission)
);
CREATE TABLE agent_tasks (
  id INTEGER PRIMARY KEY,
  agent_key TEXT NOT NULL REFERENCES agents(key),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  payload TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  error TEXT,
  progress_note TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  timeout_ms INTEGER NOT NULL DEFAULT 600000,
  run_after ${ts},
  started_at TEXT,
  finished_at TEXT,
  heartbeat_at TEXT,
  company_id INTEGER REFERENCES companies(id),
  entity_type TEXT,
  entity_id INTEGER,
  parent_task_id INTEGER REFERENCES agent_tasks(id),
  dedupe_key TEXT,
  created_by TEXT NOT NULL,
  created_at ${ts},
  updated_at ${ts}
);
CREATE INDEX idx_tasks_queue ON agent_tasks(status, run_after, priority);
CREATE INDEX idx_tasks_entity ON agent_tasks(entity_type, entity_id);
CREATE UNIQUE INDEX idx_tasks_dedupe ON agent_tasks(dedupe_key) WHERE dedupe_key IS NOT NULL AND status IN ('QUEUED','RUNNING','RETRY_SCHEDULED');
CREATE VIEW event_research_tasks AS SELECT * FROM agent_tasks WHERE entity_type = 'event';
CREATE TABLE agent_executions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at ${ts},
  finished_at TEXT,
  error TEXT
);
CREATE TABLE agent_actions (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES agent_tasks(id) ON DELETE CASCADE,
  agent_key TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at ${ts}
);
CREATE INDEX idx_agent_actions_task ON agent_actions(task_id);
CREATE TABLE agent_messages (
  id INTEGER PRIMARY KEY,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  task_id INTEGER REFERENCES agent_tasks(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at ${ts}
);

-- Connectors, MCP, audit ----------------------------------------------------
CREATE TABLE connector_status (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  endpoint TEXT,
  access_method TEXT,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error TEXT,
  records_total INTEGER NOT NULL DEFAULT 0,
  last_new INTEGER NOT NULL DEFAULT 0,
  last_updated INTEGER NOT NULL DEFAULT 0,
  failed_requests INTEGER NOT NULL DEFAULT 0,
  rate_limit TEXT,
  coverage_notes TEXT NOT NULL DEFAULT '',
  sync_cursor TEXT
);
CREATE TABLE ingestion_jobs (
  id INTEGER PRIMARY KEY,
  connector_key TEXT NOT NULL REFERENCES connector_status(key),
  task_id INTEGER REFERENCES agent_tasks(id),
  status TEXT NOT NULL,
  params TEXT,
  fetched INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at ${ts},
  finished_at TEXT
);
CREATE TABLE data_quality_checks (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  check_name TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at ${ts}
);
CREATE TABLE mcp_servers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  transport TEXT NOT NULL,
  command TEXT,
  args TEXT,
  url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'UNVERIFIED',
  last_error TEXT,
  last_discovered_at TEXT,
  config_origin TEXT NOT NULL
);
CREATE TABLE mcp_tools (
  id INTEGER PRIMARY KEY,
  server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  description TEXT,
  input_schema TEXT,
  output_schema TEXT,
  permission_required TEXT NOT NULL,
  status TEXT NOT NULL,
  last_success_at TEXT,
  last_error TEXT,
  UNIQUE(server_id, tool_name)
);
CREATE TABLE mcp_tool_executions (
  id INTEGER PRIMARY KEY,
  tool_id INTEGER REFERENCES mcp_tools(id),
  server_name TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  task_id INTEGER REFERENCES agent_tasks(id),
  authorized INTEGER NOT NULL,
  input TEXT,
  status TEXT NOT NULL,
  output_excerpt TEXT,
  error TEXT,
  duration_ms INTEGER,
  executed_at ${ts}
);
CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  company_id INTEGER,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id INTEGER,
  summary TEXT NOT NULL,
  detail TEXT,
  created_at ${ts}
);
CREATE INDEX idx_audit_created ON audit_logs(created_at);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

CREATE VIRTUAL TABLE search_index USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
`,
  },
  {
    id: 2,
    name: "api_tokens",
    sql: `
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scopes TEXT NOT NULL,
  last_used_at TEXT,
  created_at ${ts}
);
`,
  },
  {
    id: 3,
    name: "policy_opening_terms",
    sql: `
ALTER TABLE negotiation_policies ADD COLUMN opening_unit_price REAL;
ALTER TABLE negotiation_policies ADD COLUMN opening_lead_time_days INTEGER;
ALTER TABLE negotiation_policies ADD COLUMN opening_payment_terms TEXT;
ALTER TABLE negotiation_policies ADD COLUMN opening_delivery_terms TEXT;
ALTER TABLE negotiation_policies ADD COLUMN opening_validity_days INTEGER;
`,
  },
  {
    id: 4,
    name: "field_requests",
    sql: `
CREATE TABLE field_reps (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_by_user_id INTEGER REFERENCES users(id),
  created_at ${ts},
  UNIQUE(company_id, email)
);
CREATE TABLE field_requests (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  rep_id INTEGER NOT NULL REFERENCES field_reps(id),
  event_id INTEGER REFERENCES events(id),
  target_company_id INTEGER REFERENCES companies(id),
  token TEXT NOT NULL UNIQUE,
  stand_hint TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  mode TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT,
  sent_at TEXT,
  replied_at TEXT,
  summary TEXT,
  created_at ${ts}
);
CREATE TABLE email_attachments (
  id INTEGER PRIMARY KEY,
  field_request_id INTEGER REFERENCES field_requests(id) ON DELETE CASCADE,
  message_ref TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size INTEGER,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  extraction_status TEXT NOT NULL,
  extracted TEXT,
  created_at ${ts},
  UNIQUE(message_ref, filename)
);
CREATE TABLE inbox_seen (message_ref TEXT PRIMARY KEY, seen_at ${ts});
`,
  },
  {
    id: 5,
    name: "field_chain",
    sql: `
ALTER TABLE field_requests ADD COLUMN rfq_terms TEXT;
ALTER TABLE field_requests ADD COLUMN auto_negotiate INTEGER NOT NULL DEFAULT 0;
ALTER TABLE field_requests ADD COLUMN briefing TEXT;
ALTER TABLE field_requests ADD COLUMN negotiation_id INTEGER REFERENCES negotiations(id);
ALTER TABLE negotiation_policies ADD COLUMN simulated INTEGER NOT NULL DEFAULT 0;
`,
  },
  {
    id: 6,
    name: "missions",
    sql: `
CREATE TABLE missions (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT NOT NULL,
  prompt TEXT,
  parsed TEXT,
  status TEXT NOT NULL,
  event_id INTEGER REFERENCES events(id),
  target_company_id INTEGER REFERENCES companies(id),
  ranking TEXT,
  plan TEXT,
  field_request_id INTEGER REFERENCES field_requests(id),
  negotiation_id INTEGER REFERENCES negotiations(id),
  deal_id INTEGER REFERENCES deals(id),
  error TEXT,
  created_at ${ts},
  updated_at ${ts}
);
CREATE TABLE mission_steps (
  id INTEGER PRIMARY KEY,
  mission_id INTEGER NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  detail TEXT,
  created_at ${ts}
);
CREATE INDEX idx_mission_steps ON mission_steps(mission_id, id);
CREATE TABLE demo_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
ALTER TABLE field_requests ADD COLUMN mission_id INTEGER REFERENCES missions(id);
`,
  },
  {
    id: 7,
    name: "supplier_profiles",
    sql: `
CREATE TABLE supplier_profiles (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  event_id INTEGER REFERENCES events(id),
  own_company INTEGER NOT NULL DEFAULT 0,
  focus TEXT NOT NULL,
  attendees TEXT NOT NULL DEFAULT '[]',
  stand TEXT,
  days_present TEXT,
  bringing TEXT NOT NULL DEFAULT '[]',
  shareable TEXT NOT NULL DEFAULT '[]',
  gated TEXT NOT NULL DEFAULT '[]',
  meeting_slots TEXT NOT NULL DEFAULT '[]',
  created_by_user_id INTEGER REFERENCES users(id),
  updated_at ${ts}
);
`,
  },
  { id: 8, name: "mission_archive", sql: `ALTER TABLE missions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;` },
  {
    id: 9,
    name: "agent_emails",
    sql: `
CREATE TABLE agent_emails (
  id INTEGER PRIMARY KEY,
  mission_id INTEGER REFERENCES missions(id),
  kind TEXT NOT NULL,
  from_addr TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at ${ts}
);
CREATE INDEX idx_agent_emails_created ON agent_emails(created_at);
`,
  },
  { id: 10, name: "campaigns", sql: `ALTER TABLE missions ADD COLUMN parent_id INTEGER REFERENCES missions(id); ALTER TABLE missions ADD COLUMN report TEXT;` },
];
