// Loggers for the webhook route and the worker: M1-04's pino logger (`@/lib/logger`, with its
// redaction list) as a child with fixed fields. The adapter's `Logger` call shape
// (`logger.info(obj, msg)`) is pino's, so one logger serves the route, the worker and the adapter.
import type { Logger } from "@carnet/airwallex";
import { createLogger as createPino } from "../lib/logger";

export type { Logger };

export function createLogger(base: Record<string, unknown> = {}): Logger {
  return createPino({ name: "carnet-web" }).child(base);
}

type Level = "debug" | "info" | "warn" | "error";

/** A logger that records lines in memory (tests). */
export function memoryLogger(): Logger & {
  lines: { level: Level; obj: Record<string, unknown>; msg?: string }[];
} {
  const lines: { level: Level; obj: Record<string, unknown>; msg?: string }[] = [];
  const push = (level: Level) => (obj: Record<string, unknown>, msg?: string) => {
    lines.push({ level, obj, ...(msg === undefined ? {} : { msg }) });
  };
  return {
    lines,
    debug: push("debug"),
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
  };
}
