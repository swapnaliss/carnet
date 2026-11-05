// Security headers on every response (M1-10, STRIDE table in docs/architecture.md §8).
//
// Two parts, because one of them changes per request:
// - `staticSecurityHeaders()`: the fixed set, sent on every path (pages, route handlers, static
//   assets) through `headers()` in next.config.ts.
// - `contentSecurityPolicy(nonce)`: the CSP, with a fresh nonce per request, set by the proxy
//   (src/proxy.ts → `withContentSecurityPolicy`). Next.js reads the nonce from the request's CSP header
//   and puts it on its own scripts, which is why every page renders dynamically (the root layout
//   awaits `connection()`). Scripts run only from 'self' or with the nonce ('strict-dynamic' lets a
//   nonced script load the chunks it needs); there is no 'unsafe-inline' for scripts.
//   Styles allow 'unsafe-inline': React writes `style` attributes, which a nonce cannot cover. The
//   ticket's rule is about scripts; inline styles cannot run code.
// M3-06 tightens Referrer-Policy to `no-referrer` on the payee pages with its own `headers()` entry.

export const CSP_NONCE_HEADER = "x-nonce";

export interface CspOptions {
  /** `next dev` only: React's dev build needs eval for its error overlay. */
  readonly dev?: boolean;
}

/** A nonce for one response: 16 random bytes, base64. */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function contentSecurityPolicy(nonce: string, options: CspOptions = {}): string {
  const scriptSrc = ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'"];
  if (options.dev) scriptSrc.push("'unsafe-eval'");
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export interface HeaderPair {
  readonly key: string;
  readonly value: string;
}

/** The fixed headers. `production` adds HSTS (the platform terminates TLS in front of the app). */
export function staticSecurityHeaders(options: { production: boolean }): HeaderPair[] {
  const headers: HeaderPair[] = [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  ];
  if (options.production) {
    headers.push({
      key: "Strict-Transport-Security",
      value: "max-age=63072000; includeSubDomains",
    });
  }
  return headers;
}

/**
 * For the proxy: the request headers to forward (with the CSP, so Next.js finds the nonce, and
 * `x-nonce` for server components that need it) and the CSP to put on the response.
 */
export function cspForRequest(
  requestHeaders: Headers,
  options: CspOptions = {},
): { requestHeaders: Headers; csp: string; nonce: string } {
  const nonce = newNonce();
  const csp = contentSecurityPolicy(nonce, options);
  const forwarded = new Headers(requestHeaders);
  forwarded.set(CSP_NONCE_HEADER, nonce);
  forwarded.set("Content-Security-Policy", csp);
  return { requestHeaders: forwarded, csp, nonce };
}
