// Next.js proxy (the Next 16 name for middleware). Each concern is its own module, composed here:
// - security headers (M1-10): a per-request CSP nonce, lib/security-headers.ts
// - correlation id (M1-09): a safe inbound x-request-id or a new UUID, set on the request (so route
//   handlers, pages and their logs use it, lib/request-context.ts) and on the response
// The fixed security headers come from next.config.ts `headers()`, so static assets get them too.
import { type NextRequest, NextResponse } from "next/server";
import { REQUEST_ID_HEADER, resolveRequestId } from "./lib/request-id";
import { cspForRequest } from "./lib/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const { requestHeaders, csp } = cspForRequest(request.headers, {
    dev: process.env.NODE_ENV === "development",
  });
  const requestId = resolveRequestId(request.headers.get(REQUEST_ID_HEADER));
  requestHeaders.set(REQUEST_ID_HEADER, requestId);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  response.headers.set(REQUEST_ID_HEADER, requestId);
  return response;
}

export const config = {
  // Everything except build assets, which carry no document and get the fixed headers only.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
