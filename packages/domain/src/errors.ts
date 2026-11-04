// The one API error shape (ADR 0004): { error: { code, message, details?, request_id } }.
// The code set is closed; adding a code is a deliberate change to this table.
import { z } from "zod";

/** Every error code the API can return, with its HTTP status. */
export const ERROR_HTTP_STATUS = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PRECONDITION_FAILED: 412,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  IDEMPOTENCY_KEY_REUSED: 422,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  UPSTREAM_ERROR: 502,
  SERVICE_UNAVAILABLE: 503,
} as const;

export type ErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorCodeSchema = z.enum(ERROR_CODES);

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string().min(1).max(1000),
    details: z.record(z.string(), z.unknown()).optional(),
    /** Carnet's correlation id for the request (not the Airwallex request_id). */
    request_id: z.string().min(1).max(128),
  }),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;

export function apiError(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): ApiError {
  return {
    error: { code, message, ...(details === undefined ? {} : { details }), request_id: requestId },
  };
}

export function httpStatusOf(code: ErrorCode): number {
  return ERROR_HTTP_STATUS[code];
}
