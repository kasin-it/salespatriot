import { getDb } from "./db/db.ts";
import { registerAllHandlers, schedulerTick } from "./agents/handlers.ts";
import { enqueueTask, recoverStaleTasks, runOne } from "./agents/orchestrator.ts";
import { expireStaleNegotiations } from "./services/negotiation.ts";

/** Background worker: executes queued agent tasks and runs the scheduler. Independent of the HTTP server and of any desktop session. */
export function startWorker(opts: { concurrency?: number } = {}): () => void {
  const bootDb = getDb();
  // Single worker process: anything still RUNNING at boot was interrupted by a restart.
  bootDb.run("UPDATE agent_tasks SET status='RETRY_SCHEDULED', error='Interrupted by restart' WHERE status='RUNNING'");
  registerAllHandlers();
  const concurrency = opts.concurrency ?? Number(process.env.ARSENAL_WORKER_CONCURRENCY ?? 3);
  let stopped = false;
  let active = 0;
  const loop = async () => {
    while (!stopped) {
      if (active >= concurrency) { await new Promise((r) => setTimeout(r, 500)); continue; }
      active++;
      void runOne().then((ran) => { active--; return ran; }).catch((e) => { active--; console.error("worker error", e); })
        .then(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    }
  };
  void loop();
  const tick = setInterval(() => {
    try { recoverStaleTasks(); schedulerTick(); expireStaleNegotiations(); } catch (e) { console.error("scheduler error", e); }
  }, 60_000);
  // Fast inbox watch: replies to field requests are picked up within seconds, from any mail client.
  const fast = setInterval(() => {
    try {
      const db = getDb();
      if (process.env.MAILPIT_URL && db.get("SELECT 1 FROM field_requests WHERE status='REQUESTED'")) enqueueTask("email", "field.poll", {}, "system:inbox-watch", { dedupeKey: "field-poll", priority: 1 });
    } catch { /* agent disabled or transient */ }
  }, 3000);
  try { recoverStaleTasks(); } catch {}
  return () => { stopped = true; clearInterval(tick); clearInterval(fast); };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startWorker();
  console.log("Arsenal AI worker started");
}
