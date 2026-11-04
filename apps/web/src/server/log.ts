// A minimal JSON line logger with the pino call shape (`logger.info(obj, msg)`), shared by the
// webhook route and the worker. M1-09 replaces it with pino and correlation ids; the shape stays.
import type { Logger } from "@carnet/airwallex";

export type { Logger };

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50 } as const;
type Level = keyof typeof LEVELS;

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw in LEVELS ? LEVELS[raw as Level] : LEVELS.info;
}

function serialise(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function createLogger(base: Record<string, unknown> = {}): Logger {
  const min = threshold();
  const write = (level: Level, obj: Record<string, unknown>, msg?: string) => {
    if (LEVELS[level] < min) return;
    const line = JSON.stringify(
      { level, time: new Date().toISOString(), ...base, ...obj, ...(msg ? { msg } : {}) },
      (_k, v) => serialise(v),
    );
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  return {
    debug: (obj, msg) => write("debug", obj, msg),
    info: (obj, msg) => write("info", obj, msg),
    warn: (obj, msg) => write("warn", obj, msg),
    error: (obj, msg) => write("error", obj, msg),
  };
}

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
