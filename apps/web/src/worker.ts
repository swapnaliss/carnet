export {};

// Worker mode skeleton (ADR 0005, 0014): logs a heartbeat and exits cleanly on SIGTERM/SIGINT.
// Runs with Node's built-in type stripping, so keep this file free of non-erasable TypeScript syntax.
const pollMs = Number(process.env.WORKER_POLL_MS ?? 1000);
let stopping = false;

function log(message: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", process: "worker", message, ...extra }));
}

function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  log("shutdown requested", { signal });
}

process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

log("worker started", { pollMs });
let ticks = 0;
while (!stopping) {
  ticks += 1;
  if (ticks % 30 === 1) log("worker heartbeat", { ticks });
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}
log("worker stopped");
process.exit(0);
