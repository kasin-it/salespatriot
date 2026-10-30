import type { Db } from "../db/db.ts";

export interface NormalizedNotice {
  sourceKey: string;
  retrievedVia: string;
  sourceNoticeId: string;
  sourceUrl: string;
  publicationDate: string | null;
  originalPayload: unknown;
  contractingAuthority: string | null;
  authorityNationalId: string | null;
  title: string | null;
  description: string | null;
  cpvCodes: string[];
  deadline: string | null;
  estimatedValue: number | null;
  currency: string | null;
  lots: unknown[];
  technicalRequirements: string | null;
  noticeType: string | null;
  procurementStatus: string | null;
  legalBasis: string | null;
  contractNature: string | null;
  country: string | null;
  awardedSuppliers: { name: string; country: string | null }[];
}

export interface SyncResult {
  fetched: number;
  created: number;
  updated: number;
  failed: number;
  cursor: string | null;
}

export interface ConnectorInfo {
  key: string;
  status: string;
  lastAttempt: string | null;
  lastSuccess: string | null;
}

export type { Db };
