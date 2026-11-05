// Correlation ids (ADR 0015, M1-09). One mutable record per request or job lives in
// AsyncLocalStorage; the pino logger (./logger.ts) copies it onto every line through its mixin, so a
// handler never passes ids around by hand.
//
//   request_id  every HTTP request (withRequestContext): a safe inbound `x-request-id`, or a new UUID;
//               echoed in the `x-request-id` response header and in the shared error body
//   event_id    the Airwallex event id, added by the webhook route and carried by its job
//   job_id      every outbox job the worker runs (plus job_kind)
//   rfi_id      jobs about an RFI
//   run_id      agent runs (M2-00 sets it with `addContext({ run_id })`)
//
// A line written outside any request or job (worker start, heartbeat, shutdown) carries
// `request_id: "process:<uuid>"`, the id of the process's lifetime, so every line has one.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id";

export interface CorrelationFields {
  request_id?: string;
  event_id?: string;
  job_id?: string;
  job_kind?: string;
  rfi_id?: string;
  run_id?: string;
}

const storage = new AsyncLocalStorage<CorrelationFields>();

/** The id of this process's lifetime, for lines outside any request or job. */
export const PROCESS_CORRELATION_ID = `process:${randomUUID()}`;

export { REQUEST_ID_HEADER, SAFE_REQUEST_ID } from "./request-id";

/**
 * A safe inbound `x-request-id`, or a new UUID. Behind src/proxy.ts the header is already resolved
 * (the proxy sets it on the request), so the route, the page and the response share one id.
 */
export function requestIdOf(req: Request): string {
  return resolveRequestId(req.headers.get(REQUEST_ID_HEADER));
}

/** Runs `fn` with `fields` as the current context (nested calls inherit and extend the outer one). */
export function runWithContext<T>(fields: CorrelationFields, fn: () => T): T {
  const outer = storage.getStore();
  return storage.run({ ...outer, ...fields }, fn);
}

/** Adds fields to the current context (no-op outside one). */
export function addContext(fields: CorrelationFields): void {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

/** The current context's fields (a copy), or `{}`. */
export function currentContext(): CorrelationFields {
  return { ...storage.getStore() };
}

/** The current request id; outside a request, a fresh UUID. */
export function currentRequestId(): string {
  return storage.getStore()?.request_id ?? randomUUID();
}

/** Fields the logger adds to each line: the context, or the process id when there is none. */
export function logFields(): CorrelationFields {
  const store = storage.getStore();
  if (store?.request_id || store?.job_id) return { ...store };
  return { ...store, request_id: PROCESS_CORRELATION_ID };
}

function withRequestIdHeader(res: Response, requestId: string): Response {
  try {
    res.headers.set("x-request-id", requestId);
    return res;
  } catch {
    // Immutable headers (a fetched or redirect response): copy.
    const headers = new Headers(res.headers);
    headers.set("x-request-id", requestId);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

/**
 * Wraps a route handler: assigns the request id, runs the handler inside its context and returns
 * the id in `x-request-id`. Every route handler is exported through it.
 */
export function withRequestContext<A extends unknown[]>(
  handler: (req: Request, ...rest: A) => Response | Promise<Response>,
): (req: Request, ...rest: A) => Promise<Response> {
  return async (req, ...rest) => {
    const requestId = requestIdOf(req);
    const res = await runWithContext({ request_id: requestId }, () => handler(req, ...rest));
    return withRequestIdHeader(res, requestId);
  };
}
