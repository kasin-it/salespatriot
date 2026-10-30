// Domain vocabulary shared by the API, the web app and the MCP server.
// Every value here is a label for real data; none of it is data itself.

export const SOURCE_TYPES = [
  "OFFICIAL_EVENT_WEBSITE",
  "OFFICIAL_COMPANY_WEBSITE",
  "GOVERNMENT_API",
  "GOVERNMENT_REGISTRY",
  "PROCUREMENT_PORTAL",
  "PUBLIC_DOCUMENT",
  "THIRD_PARTY",
  "USER_PROVIDED",
  "MCP_TOOL",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** How a fact is known. Inferred facts must never be shown as confirmed. */
export const FACT_KINDS = [
  "OFFICIALLY_VERIFIED",
  "COMPANY_PUBLISHED",
  "GOVERNMENT_PUBLISHED",
  "THIRD_PARTY",
  "INFERRED",
  "USER_PROVIDED",
  "UNKNOWN",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export const VERIFICATION_STATUSES = ["VERIFIED", "UNVERIFIED", "NEEDS_REVIEW", "REJECTED", "SUPERSEDED"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const COMPANY_IDENTITY_STATES = ["UNVERIFIED", "IDENTIFIED", "VERIFIED", "NEEDS_REVIEW", "INACTIVE"] as const;
export type CompanyIdentityState = (typeof COMPANY_IDENTITY_STATES)[number];

export const DEMAND_CLASSES = ["CONFIRMED_DEMAND", "HISTORICAL_DEMAND", "INFERRED_DEMAND", "USER_PROVIDED_DEMAND"] as const;
export type DemandClass = (typeof DEMAND_CLASSES)[number];

export const CAPABILITY_CLASSES = [
  "VERIFIED_CAPABILITY",
  "PUBLICLY_CLAIMED_CAPABILITY",
  "INFERRED_CAPABILITY",
  "UNVERIFIED_CAPABILITY",
] as const;
export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

export const MATCH_STATUSES = ["VERIFIED_MATCH", "POTENTIAL_MATCH", "INSUFFICIENT_INFORMATION", "INCOMPATIBLE"] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

export const CONNECTOR_STATUSES = ["CONNECTED", "UNVERIFIED", "ACCESS_REQUIRED", "NOT_CONFIGURED", "DISABLED", "ERROR"] as const;
export type ConnectorStatus = (typeof CONNECTOR_STATUSES)[number];

export const TASK_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "WAITING_APPROVAL",
  "RETRY_SCHEDULED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const NEGOTIATION_STATES = [
  "INITIAL_CONTACT",
  "REQUIREMENTS_CLARIFICATION",
  "RFQ_SENT",
  "QUOTATION_RECEIVED",
  "COUNTEROFFER",
  "NEGOTIATION",
  "TERMS_AGREED",
  "PENDING_ACCEPTANCE",
  "ACCEPTED",
  "REJECTED",
  "EXPIRED",
  "CANCELLED",
] as const;
export type NegotiationState = (typeof NEGOTIATION_STATES)[number];

export const TERMINAL_NEGOTIATION_STATES: readonly NegotiationState[] = ["ACCEPTED", "REJECTED", "EXPIRED", "CANCELLED"];

export const AGENT_KEYS = [
  "event_discovery",
  "event_research",
  "event_monitoring",
  "company_identity",
  "company_discovery",
  "buyer_intelligence",
  "supplier_intelligence",
  "buyer_agent",
  "supplier_agent",
  "matching",
  "email",
  "voice",
  "negotiation",
  "deal_closing",
] as const;
export type AgentKey = (typeof AGENT_KEYS)[number];

export const COMPANY_ROLES = ["ADMIN", "MEMBER", "VIEWER"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

/** Transaction mode. SANDBOX records never count as real business. */
export const TRANSACTION_MODES = ["REAL", "SANDBOX"] as const;
export type TransactionMode = (typeof TRANSACTION_MODES)[number];

export const UNKNOWN_LABEL = "Unknown";

export interface Provenance {
  sourceUrl: string | null;
  sourceType: SourceType;
  evidenceText: string | null;
  collectedAt: string;
  lastVerifiedAt: string | null;
  confidence: number;
  verificationStatus: VerificationStatus;
  factKind: FactKind;
}

export interface OfferTerms {
  unitPrice: number | null;
  currency: string | null;
  quantity: number | null;
  moq: number | null;
  deliveryTerms: string | null;
  deliveryLocation: string | null;
  leadTimeDays: number | null;
  paymentTerms: string | null;
  warranty: string | null;
  technicalSpecs: string | null;
  validUntil: string | null;
}

export const REQUIRED_OFFER_TERMS: readonly (keyof OfferTerms)[] = [
  "unitPrice",
  "currency",
  "quantity",
  "deliveryTerms",
  "leadTimeDays",
  "paymentTerms",
  "validUntil",
];
