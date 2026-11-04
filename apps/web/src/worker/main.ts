// Worker mode entry (PROCESS_MODE=worker, ADR 0005, 0014). The image runs the esbuild bundle of this
// file (`npm run build:worker -w @carnet/web` -> apps/web/dist/worker.mjs), which inlines the
// workspace packages, so it needs no TypeScript loader at run time (BL-01 6575762493).
import { configFromEnv, createAirwallexClient } from "@carnet/airwallex";
import { createDbClientFromEnv } from "@carnet/db";
import { createLogger } from "../server/log";
import { DEFAULT_MAX_ATTEMPTS } from "./backoff";
import { createWorker, DEFAULT_POLL_MS } from "./loop";
import { defaultRegistry, intFromEnv, runWorkerProcess } from "./run";

const logger = createLogger({ process: "worker" });

async function main(): Promise<void> {
  const env = process.env;
  const pollMs = intFromEnv(env, "WORKER_POLL_MS", DEFAULT_POLL_MS);
  const maxAttempts = intFromEnv(env, "OUTBOX_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
  const db = createDbClientFromEnv(env, {
    max: 4,
    onIdleError: (error) => logger.warn({ error: error.message }, "idle database client error"),
  });
  const airwallex = createAirwallexClient({ ...configFromEnv(env), logger });
  const worker = createWorker({
    db: db.db,
    registry: defaultRegistry(),
    airwallex,
    logger,
    pollMs,
    maxAttempts,
  });
  await runWorkerProcess({ worker, logger, close: () => db.close() });
}

main().catch((error: unknown) => {
  // Configuration errors name the missing key, never a value.
  logger.error(
    { error: error instanceof Error ? error.message : String(error) },
    "worker failed to start",
  );
  process.exit(1);
});
