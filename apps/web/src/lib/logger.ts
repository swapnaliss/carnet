// Structured JSON logs (pino, ADR 0015). Credentials never reach a log line: the redaction list
// covers passwords, tokens, cookies and auth headers wherever they sit in a logged object, and the
// auth code logs ids and outcomes, never request bodies.
import pino, { type DestinationStream, type Logger } from "pino";

export type { Logger };

export const REDACT_PATHS = [
  "password",
  "*.password",
  "token",
  "*.token",
  "*.*.token",
  "cookie",
  "*.cookie",
  "headers.cookie",
  "headers.authorization",
  "*.headers.cookie",
  "*.headers.authorization",
  "set-cookie",
  "*.set-cookie",
  "authorization",
  "*.authorization",
  "secret",
  "*.secret",
];

export function createLogger(
  options: { level?: string; name?: string } = {},
  destination?: DestinationStream,
): Logger {
  const config = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: { service: options.name ?? "carnet-web" },
    redact: { paths: REDACT_PATHS, censor: "[redacted]" },
  };
  return destination ? pino(config, destination) : pino(config);
}

let shared: Logger | undefined;

/** The process-wide logger. */
export function logger(): Logger {
  shared ??= createLogger();
  return shared;
}
