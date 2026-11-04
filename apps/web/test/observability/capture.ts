// Captures pino output (one JSON line per write) for the observability tests.
import type { DestinationStream } from "pino";
import { createLogger, type Logger } from "../../src/lib/logger";

export interface Captured {
  readonly raw: string[];
  readonly dest: DestinationStream;
  lines(): Record<string, unknown>[];
}

export function capture(): Captured {
  const raw: string[] = [];
  return {
    raw,
    dest: { write: (s: string) => void raw.push(s) },
    lines: () =>
      raw.flatMap((chunk) => chunk.split("\n").filter(Boolean)).map((l) => JSON.parse(l)),
  };
}

/** A pino logger with the production config (redaction, iso time, correlation mixin) into `c`. */
export function capturedLogger(c: Captured, base: Record<string, unknown> = {}): Logger {
  return createLogger({ level: "debug" }, c.dest).child(base);
}
