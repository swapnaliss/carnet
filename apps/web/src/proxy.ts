// Next.js proxy (the Next 16 name for middleware). Each concern is its own module, composed here:
// - security headers (M1-10): a per-request CSP nonce, lib/security-headers.ts
// The fixed security headers come from next.config.ts `headers()`, so static assets get them too.
import { type NextRequest, NextResponse } from "next/server";
import { cspForRequest } from "./lib/security-headers";

export function proxy(request: NextRequest): NextResponse {
  const { requestHeaders, csp } = cspForRequest(request.headers, {
    dev: process.env.NODE_ENV === "development",
  });
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  // Everything except build assets, which carry no document and get the fixed headers only.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
