// Structured JSON logs (pino, ADR 0015). Credentials never reach a log line: the redaction list
// covers passwords, tokens, cookies and auth headers wherever they sit in a logged object, and the
// auth code logs ids and outcomes, never request bodies. Personal identifiers (email, phone, bank
// account numbers) are redacted too (minimum PII: synthetic today, real customers later).
// Every line carries the correlation ids of the request or job it belongs to (./request-context.ts).
import pino, { type DestinationStream, type Logger } from "pino";
import { logFields } from "./request-context";

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
  "apiKey",
  "*.apiKey",
  "api_key",
  "*.api_key",
  "headers.x-api-key",
  "*.headers.x-api-key",
  "clientSecret",
  "*.clientSecret",
  "client_secret",
  "*.client_secret",
  "accessToken",
  "*.accessToken",
  "access_token",
  "*.access_token",
  "email",
  "*.email",
  "phone",
  "*.phone",
  "accountNumber",
  "*.accountNumber",
  "account_number",
  "*.account_number",
  "iban",
  "*.iban",
];

export const REDACTED = "[Redacted]";

export function createLogger(
  options: { level?: string; name?: string } = {},
  destination?: DestinationStream,
): Logger {
  const config = {
    level: options.level ?? process.env.LOG_LEVEL ?? "info",
    base: { service: options.name ?? "carnet-web" },
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: "msg",
    mixin: () => ({ ...logFields() }),
  };
  return destination ? pino(config, destination) : pino(config);
}

let shared: Logger | undefined;

/** The process-wide logger. */
export function logger(): Logger {
  shared ??= createLogger();
  return shared;
}
