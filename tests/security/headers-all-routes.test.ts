// "Rate limits and headers" (M4-04 scope 7): the full header set on an app page, an API route and the
// payee status route. The CSP comes from the proxy, the rest from next.config.ts.
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import config from "../../apps/web/next.config";
import { staticSecurityHeaders } from "../../apps/web/src/lib/security-headers";
import { proxy } from "../../apps/web/src/proxy";

const ROUTES = {
  app: "/queue",
  api: "/api/v1/payments",
  payee: "/status/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
} as const;

/** What next.config.ts applies to `path`: the global rule, then any rule whose source matches. */
async function configHeaders(path: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const rule of (await config.headers?.()) ?? []) {
    const re = new RegExp(`^${rule.source.replace(":path*", ".*").replace(":token", "[^/]+")}$`);
    if (!re.test(path)) continue;
    for (const h of rule.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

describe.each(Object.entries(ROUTES))("security headers on the %s route", (_name, path) => {
  it("carries the CSP, nosniff, referrer policy, framing and permissions headers", async () => {
    const csp = proxy(new NextRequest(`http://localhost${path}`)).headers.get(
      "content-security-policy",
    );
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    const h = await configHeaders(path);
    expect(h.get("x-content-type-options")).toBe("nosniff");
    expect(h.get("x-frame-options")).toBe("DENY");
    expect(h.get("referrer-policy")).toBeTruthy();
    expect(h.get("permissions-policy")).toContain("camera=()");
  });

  it("adds HSTS in production", () => {
    const keys = staticSecurityHeaders({ production: true }).map((x) => x.key.toLowerCase());
    expect(keys).toContain("strict-transport-security");
  });
});

describe("the payee status route", () => {
  it("sends no referrer at all", async () => {
    expect((await configHeaders(ROUTES.payee)).get("referrer-policy")).toBe("no-referrer");
  });
});
