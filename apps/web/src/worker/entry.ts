// Process entry of the deploy image (ADR 0014): PROCESS_MODE=web starts the Next.js standalone server,
// PROCESS_MODE=worker starts the worker; anything else exits 2. Bundled to runtime/entry.mjs by
// scripts/build-runtime.mjs; the standalone server sits at ../apps/web/server.js relative to it.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDbClient } from "@carnet/db";
import { jsonLog, runHeartbeat } from "./heartbeat";

export const PROCESS_MODES = ["web", "worker"] as const;
export type ProcessMode = (typeof PROCESS_MODES)[number];

export function parseMode(value: string | undefined): ProcessMode | null {
  const mode = value ?? "web";
  return (PROCESS_MODES as readonly string[]).includes(mode) ? (mode as ProcessMode) : null;
}

async function startWeb(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await import(pathToFileURL(join(here, "..", "apps", "web", "server.js")).href);
}

async function startWorker(): Promise<void> {
  const stopped = new Promise<void>((resolve) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        jsonLog("shutdown requested", { signal });
        resolve();
      });
    }
  });
  const url = process.env.DATABASE_URL;
  const client = url
    ? createDbClient(url, { max: 2, connectionTimeoutMillis: 2_000, statementTimeoutMillis: 2_000 })
    : null;
  jsonLog("worker started", { db: client ? "configured" : "unconfigured" });
  // M1-05: start the outbox/reconcile loop here, alongside the heartbeat, and stop it on `stopped`.
  await runHeartbeat({ ping: client ? () => client.pool.query("SELECT 1") : null, stopped });
  await client?.close();
  jsonLog("worker stopped");
  process.exit(0);
}

const mode = parseMode(process.env.PROCESS_MODE);
if (mode === "web") await startWeb();
else if (mode === "worker") await startWorker();
else {
  console.error(
    `unknown PROCESS_MODE: ${String(process.env.PROCESS_MODE)} (expected ${PROCESS_MODES.join(" | ")})`,
  );
  process.exit(2);
}
