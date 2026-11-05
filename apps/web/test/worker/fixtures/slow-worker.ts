// A worker process for the SIGTERM test: the real `startWorker` and process signal wiring, with one
// slow handler so a job is in flight when the signal arrives. Bundled by the test with esbuild.
import { createLogger } from "../../../src/server/log";
import {
  type AirwallexReader,
  createRegistry,
  registerHandler,
} from "../../../src/worker/handlers/index";
import { startWorker, stopSignalFromProcess } from "../../../src/worker/run";

const holdMs = Number(process.env.TEST_HOLD_MS ?? "1500");
const offline = () => Promise.reject(new Error("no Airwallex in this test"));
const airwallex: AirwallexReader = {
  getTransfer: offline,
  getRfi: offline,
  listRfis: offline,
  findTransferByRequestId: offline,
};

const logger = createLogger({ process: "worker" });
const registry = registerHandler(createRegistry(), "test.slow", async (payload) => {
  logger.info({ marker: "job-started", payload }, "slow job started");
  await new Promise((resolve) => setTimeout(resolve, holdMs));
  logger.info({ marker: "job-finished" }, "slow job finished");
});

await startWorker({
  signal: stopSignalFromProcess(logger),
  logger,
  registry,
  airwallex,
  reconcileEveryMs: null,
  env: { DATABASE_URL: process.env.TEST_APP_URL, WORKER_POLL_MS: "20" },
});
logger.info({ code: 0 }, "worker exited");
process.exit(0);
