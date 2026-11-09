// GET /status/<token>: the public payee page (M3-06). A route handler, not a page component, because a
// page cannot answer 429 or set per-response headers, and this response must be the same shape for an
// unknown, an expired and a revoked token. No session, no cookie, no script.
import type { Db } from "@carnet/db";
import type { Logger } from "pino";
import { clientIp } from "../lib/ratelimit";
import { renderError, renderLimited, renderStatusPage, renderUnavailable } from "./payee-page";
import { lookupPayeeStatus, type OpenRfiLookup } from "./payee-status";

export interface PayeeStatusHandlerDeps {
  readonly db: () => Db;
  readonly logger: () => Logger;
  readonly now: () => Date;
  readonly openRfi: OpenRfiLookup;
  readonly env?: Record<string, string | undefined>;
}

/** On every response of the page: 200, 404, 429 and 503. */
export const PAYEE_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...PAYEE_PAGE_HEADERS, ...extra } });
}

export function createPayeeStatusHandler(deps: PayeeStatusHandlerDeps) {
  return async (req: Request, route: { params: Promise<{ token: string }> }): Promise<Response> => {
    const { token } = await route.params;
    try {
      const outcome = await lookupPayeeStatus(
        {
          db: deps.db(),
          now: deps.now,
          openRfi: deps.openRfi,
          ...(deps.env ? { env: deps.env } : {}),
        },
        token,
        clientIp(req),
      );
      switch (outcome.kind) {
        case "ok":
          return html(renderStatusPage(outcome.status, outcome.updatedAt), 200);
        case "limited":
          return html(renderLimited(), 429, { "Retry-After": String(outcome.retryAfter) });
        case "not_found":
          // Logged with the first 6 hash characters only, never the token.
          deps
            .logger()
            .info({ tokenHash: outcome.tokenHashPrefix }, "payee status link not available");
          return html(renderUnavailable(), 404);
      }
    } catch (error) {
      deps
        .logger()
        .error({ err: error instanceof Error ? error.message : "unknown" }, "payee status failed");
      return html(renderError(), 503, { "Retry-After": "30" });
    }
  };
}
