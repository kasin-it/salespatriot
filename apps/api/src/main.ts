import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { api } from "./routes/api.ts";
import { getDb } from "./db/db.ts";
import { startWorker } from "./worker.ts";

getDb();
const app = new Hono();
app.route("/api", api);
const dist = resolve(import.meta.dirname, "../../web/dist");
if (existsSync(dist)) {
  app.use("/*", serveStatic({ root: "../web/dist" }));
  app.get("*", serveStatic({ path: "../web/dist/index.html" }));
}
const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port, hostname: process.env.HOST ?? "127.0.0.1" }, (i) => console.log(`Arsenal AI API on http://${i.address}:${i.port}`));
// The worker runs in-process by default; run `pnpm worker` separately and set ARSENAL_EMBEDDED_WORKER=off to split them.
if (process.env.ARSENAL_EMBEDDED_WORKER !== "off") startWorker();
