// Worker mode entry (PROCESS_MODE=worker, ADR 0005, 0014). The image runs the esbuild bundle of this
// file (`npm run build:worker -w @carnet/web` -> apps/web/dist/worker.mjs), which inlines the
// workspace packages, so it needs no TypeScript loader at run time (BL-01 6575762493).
// All the work is in `startWorker` (./run.ts); this file only wires the process to it.
import { createLogger } from "../server/log";
import { startWorker, stopSignalFromProcess } from "./run";

const logger = createLogger({ process: "worker" });

startWorker({ signal: stopSignalFromProcess(logger), logger, planInputs: "production" }).then(
  () => {
    logger.info({ code: 0 }, "worker exited");
    process.exit(0);
  },
  (error: unknown) => {
    // Configuration errors name the missing key, never a value.
    logger.error(
      { error: error instanceof Error ? error.message : String(error) },
      "worker failed",
    );
    process.exit(1);
  },
);
