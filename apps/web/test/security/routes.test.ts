// Route inventory (M1-10 AC 4): every route.ts under src/app/api uses defineRoute, or is on the
// documented raw-body allowlist (RAW_BODY_ROUTES in lib/define-route.ts).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RAW_BODY_ROUTES } from "../../src/lib/define-route";
import { API_DIR, apiRoutes } from "./api-routes";

const HTTP_EXPORT = /export\s+(?:const|async function|function)\s+(GET|POST|PUT|PATCH|DELETE)\b/g;

describe("every API route goes through defineRoute or the raw-body allowlist", () => {
  const routes = apiRoutes();

  it("finds the routes (the scan itself works)", () => {
    expect(routes).toEqual(expect.arrayContaining(Object.keys(RAW_BODY_ROUTES)));
  });

  for (const route of routes) {
    it(`api/${route}`, () => {
      const source = readFileSync(join(API_DIR, route, "route.ts"), "utf8");
      if (route in RAW_BODY_ROUTES) return;
      const methods = [...source.matchAll(HTTP_EXPORT)].map((m) => m[1]);
      expect(methods.length, "exports no HTTP method").toBeGreaterThan(0);
      for (const method of methods) {
        expect(source, `${method} must be \`export const ${method} = defineRoute({...})\``).toMatch(
          new RegExp(`export const ${method} = defineRoute\\(`),
        );
      }
    });
  }

  it("the webhook, though raw, still uses the raw-body variant (rate limit, cap, error format)", () => {
    const source = readFileSync(join(API_DIR, "webhooks/airwallex/route.ts"), "utf8");
    expect(source).toMatch(/export const POST = defineRawRoute\(/);
    expect(source).toMatch(/rateLimit: \{ name: "webhook", by: "ip" \}/);
  });

  it("an allowlisted route that no longer exists is removed from the list", () => {
    for (const route of Object.keys(RAW_BODY_ROUTES)) expect(routes).toContain(route);
  });
});
