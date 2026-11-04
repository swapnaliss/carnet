// Process wrapper for worker mode: SIGTERM or SIGINT asks the loop to stop, the in-flight job
// finishes, the pool closes and the process exits 0 (ADR 0014: platforms send SIGTERM on deploy).
import type { Logger } from "../server/log";
import { createRegistry, type HandlerRegistry, JOB_KIND, registerHandler } from "./handlers/index";
import { handleRfiSync } from "./handlers/rfi";
import { handleTransferSync } from "./handlers/transfer";
import type { Worker } from "./loop";
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

export async function runWorkerProcess(input: {
  worker: Worker;
  logger: Logger;
  close: () => Promise<void>;
  exit?: (code: number) => void;
}): Promise<void> {
  const { worker, logger, close } = input;
  const exit = input.exit ?? ((code: number) => process.exit(code));
  const onSignal = (signal: NodeJS.Signals) => {
    logger.info({ signal }, "shutdown requested; finishing the in-flight job");
    worker.stop();
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  let code = 0;
  try {
    await worker.run();
  } catch (error) {
    code = 1;
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "worker crashed",
    );
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
    await close().catch(() => undefined);
  }
  logger.info({ code }, "worker exited");
  exit(code);
}
