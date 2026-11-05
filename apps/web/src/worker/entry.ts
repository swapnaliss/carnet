// Process entry of the deploy image (ADR 0014): PROCESS_MODE=web starts the Next.js standalone server,
// PROCESS_MODE=worker starts the worker; anything else exits 2. Bundled to runtime/entry.mjs by
// scripts/build-runtime.mjs; the standalone server sits at ../apps/web/server.js relative to it.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDbClient } from "@carnet/db";
import { createLogger } from "../server/log";
import { jsonLog, runHeartbeat } from "./heartbeat";
import { startWorker, stopSignalFromProcess } from "./run";

export const PROCESS_MODES = ["web", "worker"] as const;
export type ProcessMode = (typeof PROCESS_MODES)[number];

export function parseMode(value: string | undefined): ProcessMode | null {
  const mode = value ?? "web";
  return (PROCESS_MODES as readonly string[]).includes(mode) ? (mode as ProcessMode) : null;
}

/** The Airwallex keys `startWorker` needs; their absence puts the worker in degraded mode. */
export function missingAirwallexKeys(env: Record<string, string | undefined>): string[] {
  return ["AIRWALLEX_CLIENT_ID", "AIRWALLEX_API_KEY"].filter((k) => !env[k]);
}

async function startWeb(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  await import(pathToFileURL(join(here, "..", "apps", "web", "server.js")).href);
}

async function runWorker(): Promise<void> {
  const logger = createLogger({ process: "worker" });
  const signal = stopSignalFromProcess(logger);
  const missing = missingAirwallexKeys(process.env);
  if (missing.length === 0) {
    // The outbox loop (M1-05). It logs "worker heartbeat" every 30 s and records a heartbeat row.
    await startWorker({ signal, logger });
    return;
  }
  // Degraded: without Airwallex credentials the loop cannot run its handlers. Keep the process up so
  // the platform does not restart-loop, say so on every beat, and do not claim to process jobs.
  const stopped = new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
  const url = process.env.DATABASE_URL;
  const client = url
    ? createDbClient(url, { max: 2, connectionTimeoutMillis: 2_000, statementTimeoutMillis: 2_000 })
    : null;
  jsonLog("worker degraded: jobs are not processed", { missing });
  await runHeartbeat({
    ping: client ? () => client.pool.query("SELECT 1") : null,
    stopped,
    log: (message, extra) => jsonLog(message, { degraded: true, ...extra }),
  });
  await client?.close();
}

const mode = parseMode(process.env.PROCESS_MODE);
if (mode === "web") await startWeb();
else if (mode === "worker") {
  try {
    await runWorker();
    process.exit(0);
  } catch (error) {
    // Configuration errors name the missing key, never a value.
    jsonLog("worker failed", { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  }
} else {
  console.error(
    `unknown PROCESS_MODE: ${String(process.env.PROCESS_MODE)} (expected ${PROCESS_MODES.join(" | ")})`,
  );
  process.exit(2);
}
