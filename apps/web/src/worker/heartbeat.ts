// Worker liveness (ADR 0014, M1-06): a "worker heartbeat" log line every HEARTBEAT_MS (first one at
// start) with the database probe result. Deployed liveness is read from the platform log
// (docs/deployment.md). M1-05's job loop runs alongside and keeps this line.
import type { DbHealth } from "../health";
import { probeDb } from "../health";

export const HEARTBEAT_MS = 30_000;

export type Log = (message: string, extra?: Record<string, unknown>) => void;

export const jsonLog: Log = (message, extra = {}) => {
  console.log(
    JSON.stringify({
      level: "info",
      time: new Date().toISOString(),
      process: "worker",
      message,
      ...extra,
    }),
  );
};

export interface HeartbeatOptions {
  ping: (() => Promise<unknown>) | null;
  log?: Log;
  intervalMs?: number;
  /** Resolves when the worker should stop (SIGTERM/SIGINT). */
  stopped: Promise<void>;
}

/** Logs one heartbeat immediately, then one per interval, until `stopped` resolves. Returns the count. */
export async function runHeartbeat(opts: HeartbeatOptions): Promise<number> {
  const log = opts.log ?? jsonLog;
  const interval = opts.intervalMs ?? HEARTBEAT_MS;
  let stop = false;
  void opts.stopped.then(() => {
    stop = true;
  });
  let beats = 0;
  while (!stop) {
    const db: DbHealth = await probeDb(opts.ping);
    beats += 1;
    log("worker heartbeat", { beats, db });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, interval);
      }),
      opts.stopped,
    ]);
    clearTimeout(timer);
  }
  return beats;
}
