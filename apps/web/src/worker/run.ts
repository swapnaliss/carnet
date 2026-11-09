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
import { DOCUMENT_JOB_KIND } from "../server/documents/jobs";
import { createLogger, type Logger } from "../server/log";
import { DEFAULT_MAX_ATTEMPTS } from "./backoff";
import { handleTransferCreate } from "./handlers/create-transfer";
import {
  DRAFT_EVENT_KIND,
  handleDraftEvent,
  handleRfiDraft,
  RFI_DRAFT_JOB_KIND,
} from "./handlers/draft";
import { handleDocumentExtract, handleDocumentExtracted } from "./handlers/extract";
import {
  type AirwallexReader,
  type AirwallexWriter,
  createRegistry,
  type HandlerRegistry,
  JOB_KIND,
  registerHandler,
} from "./handlers/index";
import { type PlanInputsLoader, registerPlanHandlers } from "./handlers/plan";
import { handleRfiSync } from "./handlers/rfi";
import { handleAnswerSubmitted, handleRfiRespond } from "./handlers/rfi-respond";
import { handleTransferSimulate } from "./handlers/simulate-transfer";
import { handleTransferSync } from "./handlers/transfer";
import { createWorker, DEFAULT_POLL_MS } from "./loop";
import { handleReconcile } from "./reconcile";

/** The handlers worker mode runs. Later tickets register theirs here (M2-04, M2-07, M3-03). */
export function defaultRegistry(planInputs?: PlanInputsLoader): HandlerRegistry {
  const registry = createRegistry();
  registerPlanHandlers(registry, planInputs);
  registerHandler(registry, JOB_KIND.transferSync, handleTransferSync);
  registerHandler(registry, JOB_KIND.rfiSync, handleRfiSync);
  registerHandler(registry, JOB_KIND.reconcile, handleReconcile);
  registerHandler(registry, RFI_DRAFT_JOB_KIND, handleRfiDraft);
  registerHandler(registry, DRAFT_EVENT_KIND.ready, handleDraftEvent);
  registerHandler(registry, DRAFT_EVENT_KIND.needsOwner, handleDraftEvent);
  // Not `mutating`: the handler enforces the kill switch itself at consume, so a re-run of an attempt
  // already past INTENT still resolves while execution is off (ADR 0007; M2-07).
  registerHandler(registry, JOB_KIND.rfiRespond, handleRfiRespond);
  registerHandler(registry, JOB_KIND.answerSubmitted, handleAnswerSubmitted);
  registerHandler(registry, DOCUMENT_JOB_KIND.extract, handleDocumentExtract);
  registerHandler(registry, DOCUMENT_JOB_KIND.extracted, handleDocumentExtracted);
  registerHandler(registry, JOB_KIND.transferCreate, handleTransferCreate, { mutating: true });
  registerHandler(registry, JOB_KIND.transferSimulate, handleTransferSimulate, { mutating: true });
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
  /** Reads the planner's inputs; `plan.rerun` is registered only when this is supplied (M3-01/M2). */
  planInputs?: PlanInputsLoader;
  airwallex?: AirwallexReader;
  airwallexWriter?: AirwallexWriter;
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
  let airwallexWriter: AirwallexWriter | undefined = options.airwallexWriter;
  try {
    if (options.airwallex) {
      airwallex = options.airwallex;
    } else {
      const client = createAirwallexClient({ ...configFromEnv(env), logger });
      airwallex = client;
      airwallexWriter ??= client;
    }
  } catch (error) {
    await db.close().catch(() => undefined);
    throw error;
  }
  const worker = createWorker({
    db: db.db,
    registry: options.registry ?? defaultRegistry(options.planInputs),
    airwallex,
    ...(airwallexWriter ? { airwallexWriter } : {}),
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
