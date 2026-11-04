// HTTP core for the Airwallex REST API: one timeout per attempt, retries with full-jitter backoff on
// 429/502/503/504 and network errors (honouring `retry-after`), typed errors, zod-validated bodies.
// Secrets never reach a log line or an error message: only method, path, status and API code do.
import { type ApiError, apiError } from "@carnet/domain";
import type { z } from "zod";
import { parseJsonPreservingNumbers } from "./json";

export interface Logger {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class AirwallexError extends Error {
  override name = "AirwallexError";
}

/** A non-2xx answer from Airwallex. `code` is Airwallex's error code (e.g. `duplicate_request_id`). */
export class AirwallexApiError extends AirwallexError {
  override name = "AirwallexApiError";
  readonly status: number;
  readonly code: string;
  readonly source: string | undefined;
  readonly details: unknown;
  readonly method: string;
  readonly path: string;
  constructor(args: {
    status: number;
    code: string;
    apiMessage?: string | undefined;
    source?: string | undefined;
    details?: unknown;
    method: string;
    path: string;
    hint?: string | undefined;
  }) {
    const what = args.apiMessage ? `: ${args.apiMessage}` : "";
    const hint = args.hint ? ` (${args.hint})` : "";
    super(`${args.method} ${args.path} -> ${args.status} ${args.code}${what}${hint}`);
    this.status = args.status;
    this.code = args.code;
    this.source = args.source;
    this.details = args.details;
    this.method = args.method;
    this.path = args.path;
  }
}

/** 429 after the configured attempts (or a `retry-after` longer than we are willing to wait). */
export class AirwallexRateLimited extends AirwallexApiError {
  override name = "AirwallexRateLimited";
  readonly retryAfterMs: number | undefined;
  constructor(args: { method: string; path: string; retryAfterMs: number | undefined }) {
    super({ status: 429, code: "rate_limited", method: args.method, path: args.path });
    this.retryAfterMs = args.retryAfterMs;
  }
}

/** No answer within the timeout. The outcome of a POST is UNKNOWN: look the object up (ADR 0007). */
export class AirwallexTimeout extends AirwallexError {
  override name = "AirwallexTimeout";
  readonly method: string;
  readonly path: string;
  readonly timeoutMs: number;
  constructor(args: { method: string; path: string; timeoutMs: number }) {
    super(`${args.method} ${args.path} timed out after ${args.timeoutMs} ms`);
    this.method = args.method;
    this.path = args.path;
    this.timeoutMs = args.timeoutMs;
  }
}

/** The connection failed before any answer (DNS, reset, TLS). */
export class AirwallexNetworkError extends AirwallexError {
  override name = "AirwallexNetworkError";
  constructor(method: string, path: string, cause?: unknown) {
    super(`${method} ${path} failed: network error`, { cause });
  }
}

/** A 2xx body that does not match the expected schema. */
export class AirwallexInvalidResponse extends AirwallexError {
  override name = "AirwallexInvalidResponse";
  readonly issues: string[];
  constructor(method: string, path: string, issues: string[]) {
    super(`${method} ${path}: response failed validation (${issues.slice(0, 3).join("; ")})`);
    this.issues = issues;
  }
}

/** A request the adapter refuses to send (bad input caught before the network). */
export class AirwallexInputError extends AirwallexError {
  override name = "AirwallexInputError";
}

const HINTS: Record<string, string> = {
  fee_unknown: "the sandbox rejects fee_paid_by: PAYER; omit fee_paid_by (BL-01, M0-05)",
  duplicate_request_id: "the object already exists; its id is in details.id",
  invalid_state_for_operation:
    "the RFI is no longer ACTION_REQUIRED or the simulator state forbids it",
  credentials_invalid: "check AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY (values are never logged)",
};

export interface HttpConfig {
  baseUrl: string;
  filesUrl: string;
  fetch?: FetchLike;
  /** Per attempt. Default 10 000 ms (docs/architecture.md §9). */
  timeoutMs?: number;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** A `retry-after` above this is not waited for: the call fails with AirwallexRateLimited. */
  maxRetryAfterMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  logger?: Logger;
  /** Sent as `x-api-version` on non-FX calls when set. The fixtures were recorded without it. */
  apiVersion?: string | undefined;
}

export type Method = "GET" | "POST";

export interface RequestOptions<T> {
  method: Method;
  path: string;
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  host?: "api" | "files";
  headers?: Record<string, string>;
  bearer?: string;
  schema: z.ZodType<T>;
  /**
   * Safe to send again: GETs, and POSTs whose body carries a `request_id` (Airwallex de-duplicates).
   * A POST without a request_id is never retried.
   */
  retryable: boolean;
  /** FX endpoints never carry `x-api-version` (CLAUDE.md). */
  omitApiVersion?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_STATUSES = new Set([429, 502, 503, 504]);

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Parses `retry-after` (delta seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.ceil(Number(v) * 1000);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - nowMs);
}

/** Full jitter: uniform in [0, min(maxDelay, base * 2^(attempt-1))]. `attempt` starts at 1. */
export function backoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
  random: () => number,
): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
  source?: unknown;
  details?: unknown;
}

export class HttpClient {
  readonly #fetch: FetchLike;
  readonly #cfg: Required<Omit<HttpConfig, "fetch" | "apiVersion">> & {
    apiVersion: string | undefined;
  };

  constructor(cfg: HttpConfig) {
    this.#fetch = cfg.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.#cfg = {
      baseUrl: cfg.baseUrl.replace(/\/+$/, ""),
      filesUrl: cfg.filesUrl.replace(/\/+$/, ""),
      timeoutMs: cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxAttempts: cfg.maxAttempts ?? 3,
      baseDelayMs: cfg.baseDelayMs ?? 250,
      maxDelayMs: cfg.maxDelayMs ?? 4_000,
      maxRetryAfterMs: cfg.maxRetryAfterMs ?? 30_000,
      random: cfg.random ?? Math.random,
      sleep: cfg.sleep ?? realSleep,
      logger: cfg.logger ?? silentLogger,
      apiVersion: cfg.apiVersion,
    };
  }

  get logger(): Logger {
    return this.#cfg.logger;
  }

  async request<T>(opts: RequestOptions<T>): Promise<T> {
    const { method, path } = opts;
    const cfg = this.#cfg;
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const started = Date.now();
      let res: Response;
      try {
        res = await this.#once(opts);
      } catch (err) {
        if (err instanceof AirwallexTimeout) {
          cfg.logger.warn({ method, path, attempt, timeoutMs: cfg.timeoutMs }, "airwallex timeout");
          throw err;
        }
        const netErr = new AirwallexNetworkError(method, path, err);
        if (opts.retryable && attempt < cfg.maxAttempts) {
          const delay = backoffDelay(attempt, cfg.baseDelayMs, cfg.maxDelayMs, cfg.random);
          cfg.logger.warn(
            { method, path, attempt, delayMs: delay },
            "airwallex network error, retrying",
          );
          await cfg.sleep(delay);
          continue;
        }
        throw netErr;
      }

      cfg.logger.debug(
        { method, path, status: res.status, attempt, durationMs: Date.now() - started },
        "airwallex response",
      );

      if (res.ok) return this.#parse(opts, res);

      if (RETRY_STATUSES.has(res.status)) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
        const canWait = retryAfterMs === undefined || retryAfterMs <= cfg.maxRetryAfterMs;
        if (opts.retryable && attempt < cfg.maxAttempts && canWait) {
          const jitter = backoffDelay(attempt, cfg.baseDelayMs, cfg.maxDelayMs, cfg.random);
          const delay = Math.max(retryAfterMs ?? 0, jitter);
          await res.body?.cancel().catch(() => undefined);
          cfg.logger.warn(
            { method, path, status: res.status, attempt, delayMs: delay },
            "airwallex retryable status, retrying",
          );
          await cfg.sleep(delay);
          continue;
        }
        if (res.status === 429) {
          await res.body?.cancel().catch(() => undefined);
          throw new AirwallexRateLimited({ method, path, retryAfterMs });
        }
      }
      throw await this.#apiError(opts, res);
    }
  }

  async #once<T>(opts: RequestOptions<T>): Promise<Response> {
    const cfg = this.#cfg;
    const base = opts.host === "files" ? cfg.filesUrl : cfg.baseUrl;
    const url = new URL(base + opts.path);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = { accept: "application/json", ...opts.headers };
    if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
    if (cfg.apiVersion && !opts.omitApiVersion) headers["x-api-version"] = cfg.apiVersion;
    let body: RequestInit["body"];
    if (opts.form) body = opts.form;
    else if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    }

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new AirwallexTimeout({ method: opts.method, path: opts.path, timeoutMs: cfg.timeoutMs }),
        );
      }, cfg.timeoutMs);
    });
    try {
      const init: RequestInit = { method: opts.method, headers, signal: controller.signal };
      if (body !== undefined) init.body = body;
      return await Promise.race([this.#fetch(url.toString(), init), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #parse<T>(opts: RequestOptions<T>, res: Response): Promise<T> {
    const text = await res.text();
    let data: unknown;
    try {
      data = text === "" ? null : parseJsonPreservingNumbers(text);
    } catch {
      throw new AirwallexInvalidResponse(opts.method, opts.path, ["body is not JSON"]);
    }
    const parsed = opts.schema.safeParse(data);
    if (!parsed.success) {
      const issues = parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      );
      throw new AirwallexInvalidResponse(opts.method, opts.path, issues);
    }
    return parsed.data;
  }

  async #apiError<T>(opts: RequestOptions<T>, res: Response): Promise<AirwallexApiError> {
    let body: ErrorBody = {};
    try {
      const parsed: unknown = JSON.parse(await res.text());
      if (parsed && typeof parsed === "object") body = parsed as ErrorBody;
    } catch {
      // non-JSON error body: keep the status only
    }
    const code = typeof body.code === "string" ? body.code : `http_${res.status}`;
    const err = new AirwallexApiError({
      status: res.status,
      code,
      apiMessage: typeof body.message === "string" ? body.message : undefined,
      source: typeof body.source === "string" ? body.source : undefined,
      details: body.details,
      method: opts.method,
      path: opts.path,
      hint: HINTS[code],
    });
    this.#cfg.logger.warn(
      { method: opts.method, path: opts.path, status: res.status, code },
      "airwallex error",
    );
    return err;
  }
}

/**
 * Maps an adapter error to the API error format (`@carnet/domain`, ADR 0004) for a route handler.
 * Bad input is VALIDATION_FAILED; anything Airwallex did (or did not) answer is UPSTREAM_ERROR with
 * the Airwallex status and code in `details`. Messages carry no secret (see the classes above).
 */
export function toApiError(err: unknown, correlationId: string): ApiError {
  if (err instanceof AirwallexInputError) {
    return apiError("VALIDATION_FAILED", err.message, correlationId);
  }
  if (err instanceof AirwallexApiError) {
    return apiError("UPSTREAM_ERROR", "Airwallex rejected the request", correlationId, {
      airwallex_status: err.status,
      airwallex_code: err.code,
    });
  }
  if (err instanceof AirwallexTimeout) {
    return apiError("UPSTREAM_ERROR", "Airwallex did not answer in time", correlationId, {
      airwallex_code: "timeout",
    });
  }
  if (err instanceof AirwallexError) {
    return apiError("UPSTREAM_ERROR", "Airwallex request failed", correlationId);
  }
  return apiError("INTERNAL", "Unexpected error", correlationId);
}
