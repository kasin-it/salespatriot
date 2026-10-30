import type { AgentKey, TaskStatus } from "@salespatriot/shared";
import { getDb, json } from "../db/db.ts";
import { audit } from "../lib/audit.ts";
import { errorMessage, now } from "../lib/util.ts";

export interface TaskContext {
  taskId: number;
  agentKey: AgentKey;
  payload: Record<string, unknown>;
  companyId: number | null;
  progress(note: string): void;
  action(action: string, entityType?: string, entityId?: number, detail?: unknown): void;
  /** Enqueue a follow-up task and record a structured agent message. */
  spawn(agentKey: AgentKey, type: string, payload: Record<string, unknown>, opts?: SpawnOptions): number | null;
  isCancelled(): boolean;
}

export interface SpawnOptions {
  dedupeKey?: string;
  priority?: number;
  runAfterMs?: number;
  companyId?: number | null;
  entityType?: string;
  entityId?: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export type TaskHandler = (ctx: TaskContext) => Promise<unknown>;
export class ApprovalRequired extends Error {
  reason: string;
  approvalPayload: unknown;
  constructor(reason: string, approvalPayload: unknown) {
    super(reason);
    this.reason = reason;
    this.approvalPayload = approvalPayload;
  }
}
/** Permanent failure: do not retry. */
export class FatalTaskError extends Error {}

const handlers = new Map<string, TaskHandler>();
export const registerHandler = (type: string, h: TaskHandler): void => void handlers.set(type, h);
export const hasHandler = (type: string): boolean => handlers.has(type);

export function enqueueTask(agentKey: AgentKey, type: string, payload: Record<string, unknown>, createdBy: string, opts: SpawnOptions & { parentTaskId?: number } = {}): number | null {
  const db = getDb();
  const agent = db.get<{ enabled: number }>("SELECT enabled FROM agents WHERE key = ?", agentKey);
  if (!agent) throw new Error(`Unknown agent ${agentKey}`);
  if (!agent.enabled) throw new Error(`Agent ${agentKey} is disabled`);
  try {
    const id = db.insert("agent_tasks", {
      agent_key: agentKey,
      type,
      status: "QUEUED",
      priority: opts.priority ?? 5,
      payload: JSON.stringify(payload),
      company_id: opts.companyId ?? null,
      entity_type: opts.entityType ?? null,
      entity_id: opts.entityId ?? null,
      parent_task_id: opts.parentTaskId ?? null,
      dedupe_key: opts.dedupeKey ?? null,
      timeout_ms: opts.timeoutMs ?? 20 * 60_000,
      max_attempts: opts.maxAttempts ?? 3,
      run_after: new Date(Date.now() + (opts.runAfterMs ?? 0)).toISOString(),
      created_by: createdBy,
    });
    audit({ actorType: createdBy.startsWith("agent:") ? "agent" : "user", actorId: createdBy, companyId: opts.companyId, action: "task.queued", entityType: "task", entityId: id, summary: `${agentKey} task "${type}" queued` });
    return id;
  } catch (e) {
    if (/UNIQUE/.test(errorMessage(e)) && opts.dedupeKey) return null; // identical task already pending
    throw e;
  }
}

export function cancelTask(id: number, by: string): boolean {
  const db = getDb();
  const r = db.run("UPDATE agent_tasks SET status='CANCELLED', finished_at=?, updated_at=? WHERE id=? AND status IN ('QUEUED','RETRY_SCHEDULED','WAITING_APPROVAL','RUNNING')", now(), now(), id);
  if (r.changes) audit({ actorType: "user", actorId: by, action: "task.cancelled", entityType: "task", entityId: id, summary: `Task ${id} cancelled` });
  return r.changes > 0;
}

interface TaskRow {
  id: number; agent_key: AgentKey; type: string; payload: string; attempts: number; max_attempts: number; timeout_ms: number; company_id: number | null; status: TaskStatus;
}

function claim(): TaskRow | undefined {
  const db = getDb();
  return db.tx(() => {
    const row = db.get<TaskRow>(
      `SELECT t.* FROM agent_tasks t JOIN agents a ON a.key = t.agent_key
       WHERE t.status IN ('QUEUED','RETRY_SCHEDULED') AND t.run_after <= ? AND a.enabled = 1
       ORDER BY t.priority ASC, t.id ASC LIMIT 1`, now());
    if (!row) return undefined;
    db.run("UPDATE agent_tasks SET status='RUNNING', attempts = attempts + 1, started_at = ?, heartbeat_at = ?, updated_at = ?, error = NULL WHERE id = ?", now(), now(), now(), row.id);
    return { ...row, attempts: row.attempts + 1 };
  });
}

/** Tasks left RUNNING by a crashed worker are re-queued (or failed once attempts are exhausted). */
export function recoverStaleTasks(): number {
  const db = getDb();
  let n = 0;
  for (const t of db.all<TaskRow & { heartbeat_at: string }>("SELECT * FROM agent_tasks WHERE status='RUNNING'")) {
    if (Date.now() - Date.parse(t.heartbeat_at) > t.timeout_ms + 30_000) {
      const exhausted = t.attempts >= t.max_attempts;
      db.update("agent_tasks", t.id, { status: exhausted ? "FAILED" : "RETRY_SCHEDULED", error: "Worker stopped or task timed out", finished_at: exhausted ? now() : null, updated_at: now() });
      n++;
    }
  }
  return n;
}

export async function runOne(): Promise<boolean> {
  const db = getDb();
  const row = claim();
  if (!row) return false;
  const execId = db.insert("agent_executions", { task_id: row.id, agent_key: row.agent_key, attempt: row.attempts, status: "RUNNING" });
  db.run("UPDATE agents SET last_activity_at = ? WHERE key = ?", now(), row.agent_key);
  const handler = handlers.get(row.type);
  const payload = json<Record<string, unknown>>(row.payload, {});
  const finish = (status: TaskStatus, extra: Record<string, unknown> = {}) => {
    db.update("agent_tasks", row.id, { status, updated_at: now(), ...extra });
    db.update("agent_executions", execId, { status, finished_at: now(), error: (extra.error as string | undefined) ?? null });
  };
  if (!handler) {
    finish("FAILED", { error: `No handler registered for task type "${row.type}"`, finished_at: now() });
    return true;
  }
  const ctx: TaskContext = {
    taskId: row.id, agentKey: row.agent_key, payload, companyId: row.company_id,
    progress: (note) => db.update("agent_tasks", row.id, { progress_note: note, heartbeat_at: now(), updated_at: now() }),
    action: (action, entityType, entityId, detail) => void db.insert("agent_actions", { task_id: row.id, agent_key: row.agent_key, action, entity_type: entityType ?? null, entity_id: entityId ?? null, detail: detail === undefined ? null : JSON.stringify(detail) }),
    spawn: (agentKey, type, p, o = {}) => {
      const id = enqueueTask(agentKey, type, p, `agent:${row.agent_key}`, { ...o, parentTaskId: row.id });
      if (id) db.insert("agent_messages", { from_agent: row.agent_key, to_agent: agentKey, task_id: id, kind: "task.request", payload: JSON.stringify({ type, ...p }) });
      return id;
    },
    isCancelled: () => db.get<{ status: string }>("SELECT status FROM agent_tasks WHERE id = ?", row.id)?.status === "CANCELLED",
  };
  try {
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      handler(ctx),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Task timed out after ${row.timeout_ms} ms`)), row.timeout_ms); }),
    ]).finally(() => clearTimeout(timer));
    if (ctx.isCancelled()) { db.update("agent_executions", execId, { status: "CANCELLED", finished_at: now() }); return true; }
    finish("SUCCEEDED", { result: JSON.stringify(result ?? null), finished_at: now() });
    audit({ actorType: "agent", actorId: row.agent_key, action: "task.succeeded", entityType: "task", entityId: row.id, summary: `${row.agent_key} "${row.type}" succeeded` });
  } catch (e) {
    if (e instanceof ApprovalRequired) {
      const approvalId = db.insert("approvals", { company_id: row.company_id, entity_type: "task", entity_id: row.id, action: row.type, reason: e.reason, payload: JSON.stringify(e.approvalPayload ?? null), requested_by: `agent:${row.agent_key}` });
      finish("WAITING_APPROVAL", { progress_note: `Waiting for approval #${approvalId}: ${e.reason}` });
      audit({ actorType: "agent", actorId: row.agent_key, companyId: row.company_id, action: "approval.requested", entityType: "approval", entityId: approvalId, summary: e.reason });
      return true;
    }
    if (ctx.isCancelled()) return true;
    const msg = errorMessage(e);
    const fatal = e instanceof FatalTaskError;
    const exhausted = fatal || row.attempts >= row.max_attempts;
    const backoff = Math.min(15 * 60_000, 30_000 * 2 ** (row.attempts - 1));
    finish(exhausted ? "FAILED" : "RETRY_SCHEDULED", { error: msg, finished_at: exhausted ? now() : null, run_after: new Date(Date.now() + (exhausted ? 0 : backoff)).toISOString() });
    audit({ actorType: "agent", actorId: row.agent_key, action: exhausted ? "task.failed" : "task.retry_scheduled", entityType: "task", entityId: row.id, summary: `${row.agent_key} "${row.type}" ${exhausted ? "failed" : "will retry"}: ${msg.slice(0, 200)}` });
  }
  return true;
}

export async function drainQueue(max = 1000): Promise<number> {
  let n = 0;
  while (n < max && (await runOne())) n++;
  return n;
}

export function approveTask(approvalId: number, userId: number, approve: boolean): void {
  const db = getDb();
  const a = db.get<{ entity_type: string; entity_id: number; status: string; company_id: number | null }>("SELECT * FROM approvals WHERE id = ?", approvalId);
  if (!a || a.status !== "PENDING") throw new Error("Approval not pending");
  db.update("approvals", approvalId, { status: approve ? "APPROVED" : "REJECTED", decided_by_user_id: userId, decided_at: now() });
  if (a.entity_type === "task") {
    if (approve) {
      const t = db.get<{ payload: string }>("SELECT payload FROM agent_tasks WHERE id = ?", a.entity_id)!;
      db.update("agent_tasks", a.entity_id, { status: "QUEUED", payload: JSON.stringify({ ...json<Record<string, unknown>>(t.payload, {}), approvedApprovalId: approvalId }), run_after: now(), updated_at: now() });
    } else cancelTask(a.entity_id, `user:${userId}`);
  }
  audit({ actorType: "user", actorId: userId, companyId: a.company_id, action: approve ? "approval.approved" : "approval.rejected", entityType: "approval", entityId: approvalId, summary: `Approval ${approvalId} ${approve ? "approved" : "rejected"}` });
}
