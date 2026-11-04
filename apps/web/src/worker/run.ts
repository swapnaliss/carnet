// Worker mode's one start function and its process wiring (ADR 0005, 0014).
//
//   await startWorker({ signal })      // or { stopped: somePromise }
//
// builds the database pool, the Airwallex client and the handler registry from the environment,
// runs the loop until the signal aborts (or `stopped` settles), lets the in-flight job finish,
// closes the pool and resolves. A process entry only has to turn SIGTERM/SIGINT into that signal
// (`stopSignalFromProcess`) and exit 0 when the promise resolves (src/worker/main.ts does exactly
// that; M1-06's PROCESS_MODE switch can call `startWorker` the same way).
import { configFromEnv, createAirwallexClient } from "@carnet/airwallex";
import { createDbClientFromEnv } from "@carnet/db";
import { createLogger, type Logger } from "../server/log";
import { DEFAULT_MAX_ATTEMPTS } from "./backoff";
import {
  type AirwallexReader,
  createRegistry,
  type HandlerRegistry,
  JOB_KIND,
  registerHandler,
} from "./handlers/index";
import { handleRfiSync } from "./handlers/rfi";
import { handleTransferSync } from "./handlers/transfer";
import { createWorker, DEFAULT_POLL_MS } from "./loop";
import { handleReconcile } from "./reconcile";

/** The handlers worker mode runs. Later tickets register theirs here (M2-04, M2-07, M3-03). */
export function defaultRegistry(): HandlerRegistry {
  const registry = createRegistry();
  registerHandler(registry, JOB_KIND.transferSync, handleTransferSync);
  registerHandler(registry, JOB_KIND.rfiSync, handleRfiSync);
  registerHandler(registry, JOB_KIND.reconcile, handleReconcile);
  return registry;
}

export function intFromEnv(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
  min = 1,
): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${key} must be an integer >= ${min}`);
  return n;
}

export interface StartWorkerOptions {
  /** Aborting it stops the loop after the in-flight job. */
  signal?: AbortSignal;
  /** Alternative to `signal`: the loop stops when this settles. */
  stopped?: Promise<unknown>;
  /** Defaults to process.env (DATABASE_URL, AIRWALLEX_*, WORKER_POLL_MS, OUTBOX_MAX_ATTEMPTS). */
  env?: Record<string, string | undefined>;
  logger?: Logger;
  /** Tests only: replace the handlers, the Airwallex reader or the reconcile cadence. */
  registry?: HandlerRegistry;
  airwallex?: AirwallexReader;
  reconcileEveryMs?: number | null;
}

/** Runs worker mode until stopped. Rejects on a configuration error (it names the key, never a value). */
export async function startWorker(options: StartWorkerOptions = {}): Promise<void> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createLogger({ process: "worker" });
  const pollMs = intFromEnv(env, "WORKER_POLL_MS", DEFAULT_POLL_MS);
  const maxAttempts = intFromEnv(env, "OUTBOX_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
  const db = createDbClientFromEnv(env, {
    max: 4,
    onIdleError: (error) => logger.warn({ error: error.message }, "idle database client error"),
  });
  let airwallex: AirwallexReader;
  try {
    airwallex = options.airwallex ?? createAirwallexClient({ ...configFromEnv(env), logger });
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  const worker = createWorker({
    db: db.db,
    registry: options.registry ?? defaultRegistry(),
    airwallex,
    logger,
    pollMs,
    maxAttempts,
    ...(options.reconcileEveryMs === undefined
      ? {}
      : { reconcileEveryMs: options.reconcileEveryMs }),
  });
  const stop = () => worker.stop();
  if (options.signal?.aborted) stop();
  options.signal?.addEventListener("abort", stop, { once: true });
  options.stopped?.then(stop, stop);
  try {
    await worker.run();
  } finally {
    options.signal?.removeEventListener("abort", stop);
    await db.close().catch(() => undefined);
  }
}

/** An AbortSignal that aborts on the first SIGTERM or SIGINT (platforms send SIGTERM on deploy). */
export function stopSignalFromProcess(logger: Logger): AbortSignal {
  const controller = new AbortController();
  const onSignal = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "shutdown requested; finishing the in-flight job");
    controller.abort();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  return controller.signal;
}
