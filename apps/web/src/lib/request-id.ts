// The request id rule (M1-09), with no Node-only imports so src/proxy.ts can use it: an inbound
// `x-request-id` is honoured only if it matches SAFE_REQUEST_ID, otherwise a new UUID replaces it.

/** Only these inbound ids are honoured; anything else is replaced (header injection, log forging). */
export const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

export const REQUEST_ID_HEADER = "x-request-id";

/** A safe inbound id, or a new UUID. */
export function resolveRequestId(incoming: string | null | undefined): string {
  return incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
}
