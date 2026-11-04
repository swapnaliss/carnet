// The one API error format (ADR 0004, M1-10): `{ error: { code, message, details?, request_id } }`
// with the closed code enum of @carnet/domain (`ERROR_HTTP_STATUS`). Every route answers errors
// through these helpers. A 500 never carries internals: an unexpected error becomes
// `INTERNAL / "Something went wrong."`, and only its class and message go to the server log.
//
// `details` by code (the only codes that carry details):
//   VALIDATION_FAILED  { issues: [{ location: "body" | "query" | "params", path: "a.b.0", code, message }] }
//   RATE_LIMITED       { retry_after_seconds }   (plus the `retry-after` header)
import { type ApiError, apiError, type ErrorCode, httpStatusOf } from "@carnet/domain";
import type { z } from "zod";

export type IssueLocation = "body" | "query" | "params";

export interface FieldIssue {
  readonly location: IssueLocation;
  /** Dotted path into the input (`""` for the whole input, e.g. an unknown key). */
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

/** A refusal a guard or handler throws; the route wrapper turns it into the shared error format. */
export class HttpProblem extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  readonly headers: Record<string, string>;
  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; headers?: Record<string, string> } = {},
  ) {
    super(message);
    this.name = "HttpProblem";
    this.code = code;
    this.details = options.details;
    this.headers = options.headers ?? {};
  }
}

export const unauthenticated = () => new HttpProblem("UNAUTHENTICATED", "Sign in to continue.");
export const forbidden = () =>
  new HttpProblem("FORBIDDEN", "Your role does not allow this action.");
/** Also the answer for another business's resource: never 403, never data. */
export const notFound = () => new HttpProblem("NOT_FOUND", "Not found.");
export const conflict = (message = "The resource changed. Reload and try again.") =>
  new HttpProblem("CONFLICT", message);
export const payloadTooLarge = () =>
  new HttpProblem("PAYLOAD_TOO_LARGE", "The request body is too large.");
export const unsupportedMediaType = (expected: string) =>
  new HttpProblem("UNSUPPORTED_MEDIA_TYPE", `Send the body as ${expected}.`);
export const rateLimited = (retryAfterSeconds: number, message = "Too many requests.") =>
  new HttpProblem("RATE_LIMITED", `${message} Try again later.`, {
    details: { retry_after_seconds: retryAfterSeconds },
    headers: { "retry-after": String(retryAfterSeconds) },
  });

export function validationFailed(issues: FieldIssue[], message = "The request is invalid.") {
  return new HttpProblem("VALIDATION_FAILED", message, { details: { issues } });
}

/** zod issues → field issues (paths only, never the rejected values). */
export function fieldIssues(location: IssueLocation, error: z.ZodError): FieldIssue[] {
  return error.issues.flatMap((issue): FieldIssue[] => {
    const path = issue.path.map(String);
    // An unknown key is reported at its own path, one issue per key.
    if (issue.code === "unrecognized_keys") {
      return issue.keys.map((key) => ({
        location,
        path: [...path, key].join("."),
        code: issue.code,
        message: "Unknown field.",
      }));
    }
    return [{ location, path: path.join("."), code: issue.code, message: issue.message }];
  });
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  headers: Record<string, string> = {},
  details?: Record<string, unknown>,
): Response {
  const body: ApiError = apiError(code, message, requestId, details);
  return Response.json(body, {
    status: httpStatusOf(code),
    headers: { "cache-control": "no-store", "x-request-id": requestId, ...headers },
  });
}

export interface ErrorLog {
  error(obj: Record<string, unknown>, msg?: string): void;
}

/** Any thrown value → a response. HttpProblem keeps its code; anything else is a bare 500. */
export function problemResponse(error: unknown, requestId: string, log: ErrorLog): Response {
  if (error instanceof HttpProblem) {
    return errorResponse(error.code, error.message, requestId, error.headers, error.details);
  }
  log.error(
    {
      event: "route.error",
      requestId,
      errClass: error instanceof Error ? error.name : typeof error,
      err: error instanceof Error ? error.message : "unknown",
    },
    "route handler failed",
  );
  return errorResponse("INTERNAL", "Something went wrong.", requestId);
}
