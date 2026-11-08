// Security headers (M1-10 AC 1): the proxy's CSP and next.config.ts's fixed headers, for /login,
// /healthz and an API route. e2e/csp.spec.ts fetches the same three paths from the built server.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import config from "../../next.config";
import {
  CSP_NONCE_HEADER,
  contentSecurityPolicy,
  staticSecurityHeaders,
} from "../../src/lib/security-headers";
import { proxy, config as proxyConfig } from "../../src/proxy";

const PATHS = ["/login", "/healthz", "/api/webhooks/airwallex"] as const;

export const EXPECTED_STATIC = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "strict-transport-security": "max-age=63072000; includeSubDomains",
} as const;

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp
      .split(";")
      .map((d) => d.trim().split(/\s+/))
      .filter((d) => d[0])
      .map(([name, ...values]) => [name as string, values]),
  );
}

/** The CSP rules the ticket fixes, checked on any CSP string. */
export function assertTicketCsp(csp: string): string {
  const d = directives(csp);
  expect(d.get("default-src")).toEqual(["'self'"]);
  expect(d.get("frame-ancestors")).toEqual(["'none'"]);
  expect(d.get("object-src")).toEqual(["'none'"]);
  expect(d.get("base-uri")).toEqual(["'self'"]);
  expect(d.get("form-action")).toEqual(["'self'"]);
  const script = d.get("script-src") ?? [];
  expect(script).not.toContain("'unsafe-inline'");
  const nonce = script.find((v) => v.startsWith("'nonce-"));
  expect(nonce).toMatch(/^'nonce-[A-Za-z0-9+/=]{16,}'$/);
  return nonce ?? "";
}

describe("proxy: Content-Security-Policy with a per-request nonce", () => {
  for (const path of PATHS) {
    it(`sets the CSP on ${path} and forwards the nonce to the renderer`, () => {
      const res = proxy(new NextRequest(`http://localhost${path}`));
      const csp = res.headers.get("content-security-policy") ?? "";
      const nonce = assertTicketCsp(csp);
      // NextResponse.next({ request: { headers } }) forwards request headers as x-middleware-request-*.
      expect(res.headers.get(`x-middleware-request-${CSP_NONCE_HEADER}`)).toBe(
        nonce.slice("'nonce-".length, -1),
      );
      expect(res.headers.get("x-middleware-request-content-security-policy")).toBe(csp);
    });
  }

  it("uses a fresh nonce per request", () => {
    const a = proxy(new NextRequest("http://localhost/login")).headers.get(
      "content-security-policy",
    );
    const b = proxy(new NextRequest("http://localhost/login")).headers.get(
      "content-security-policy",
    );
    expect(a).not.toBe(b);
  });

  it("allows eval only in next dev", () => {
    expect(contentSecurityPolicy("abc")).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy("abc", { dev: true })).toContain("'unsafe-eval'");
  });

  it("matches every path except build assets", () => {
    const [matcher] = proxyConfig.matcher;
    const re = new RegExp(`^${matcher}$`);
    for (const p of [...PATHS, "/", "/queue"]) expect(re.test(p), p).toBe(true);
    for (const p of ["/_next/static/chunks/a.js", "/_next/image", "/favicon.ico"]) {
      expect(re.test(p), p).toBe(false);
    }
  });
});

describe("next.config.ts: fixed headers on every path", () => {
  it("production adds HSTS; every other header is always present", async () => {
    const prod = Object.fromEntries(
      staticSecurityHeaders({ production: true }).map((h) => [h.key.toLowerCase(), h.value]),
    );
    expect(prod).toEqual(EXPECTED_STATIC);
    const dev = staticSecurityHeaders({ production: false }).map((h) => h.key.toLowerCase());
    expect(dev).not.toContain("strict-transport-security");

    const rules = (await config.headers?.()) ?? [];
    // The global rule, then the payee status page's own (M3-06).
    expect(rules.map((r) => r.source)).toEqual(["/:path*", "/status/:token"]);
    expect(rules[1]?.headers).toContainEqual({ key: "Referrer-Policy", value: "no-referrer" });
  });
});
