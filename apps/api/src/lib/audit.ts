import { getDb } from "../db/db.ts";

export interface AuditInput {
  actorType: "user" | "agent" | "system" | "mcp";
  actorId?: string | number | null;
  companyId?: number | null;
  action: string;
  entityType?: string;
  entityId?: number;
  summary: string;
  detail?: unknown;
}

/** Every persisted state change goes through here. The activity feed reads this table, so nothing is invented. */
export function audit(a: AuditInput): number {
  return getDb().insert("audit_logs", {
    actor_type: a.actorType,
    actor_id: a.actorId == null ? null : String(a.actorId),
    company_id: a.companyId ?? null,
    action: a.action,
    entity_type: a.entityType ?? null,
    entity_id: a.entityId ?? null,
    summary: a.summary,
    detail: a.detail === undefined ? null : JSON.stringify(a.detail),
  });
}
