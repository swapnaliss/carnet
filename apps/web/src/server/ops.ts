// The ops health summary (M1-09). `GET /api/ops/slo` answers the scheduled GitHub Actions check
// (.github/workflows/health.yml) with the SLO summary from the database, readable only with
// `Authorization: Bearer <OPS_CHECK_TOKEN>`. System-wide counts and latencies, no identifiers.
//   401 UNAUTHENTICATED     missing or wrong token
//   503 SERVICE_UNAVAILABLE OPS_CHECK_TOKEN unset or shorter than 32 characters (endpoint off)
//   200 { status: "ok" | "breach", breaches: SloBreach[], summary: SloSummary }
import { createHash, timingSafeEqual } from "node:crypto";
import { type Db, getSloSummary, type SloBreach, type SloSummary, sloBreaches } from "@carnet/db";
import type { ErrorCode } from "@carnet/domain";
import { errorResponse } from "../lib/errors";
import { logger } from "../lib/logger";
import { currentRequestId, withRequestContext } from "../lib/request-context";

export const MIN_OPS_TOKEN_LENGTH = 32;

export interface SloResponse {
  status: "ok" | "breach";
  breaches: SloBreach[];
  summary: SloSummary;
}

const digest = (v: string) => createHash("sha256").update(v).digest();

/** Constant-time check of `Authorization: Bearer <token>` against the configured token. */
export function opsTokenMatches(header: string | null, expected: string): boolean {
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(digest(presented), digest(expected)) && presented.length > 0;
}

function problem(code: ErrorCode, message: string): Response {
  return errorResponse(code, message, currentRequestId());
}

export function createSloHandler(deps: {
  db: () => Db;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}): (req: Request) => Promise<Response> {
  return withRequestContext(async (req: Request) => {
    const token = (deps.env ?? process.env).OPS_CHECK_TOKEN ?? "";
    if (token.length < MIN_OPS_TOKEN_LENGTH) {
      return problem("SERVICE_UNAVAILABLE", "The ops health check is not configured.");
    }
    if (!opsTokenMatches(req.headers.get("authorization"), token)) {
      logger().warn({ event: "ops.slo.unauthenticated" }, "ops health check refused");
      return problem("UNAUTHENTICATED", "A valid ops token is required.");
    }
    try {
      const summary = await getSloSummary(deps.db(), { now: deps.now?.() ?? new Date() });
      const breaches = sloBreaches(summary);
      const body: SloResponse = { status: breaches.length ? "breach" : "ok", breaches, summary };
      return Response.json(body, { headers: { "cache-control": "no-store" } });
    } catch (error) {
      logger().error(
        { event: "ops.slo.error", err: error instanceof Error ? error.message : "unknown" },
        "ops health summary failed",
      );
      return problem("INTERNAL", "The health summary could not be computed.");
    }
  });
}
