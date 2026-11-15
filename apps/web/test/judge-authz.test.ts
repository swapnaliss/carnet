// M4-05 AC 3 and AC 4: the judge (role `viewer`, always replay) gets 403 on EVERY mutating API route,
// and cannot reach live mode by cookie, URL or header tampering. The route table is enumerated from
// src/app/api, every mutating export is imported and called with a judge session, and a route that is
// neither covered nor on the documented exemption list fails the test (so a new route cannot land
// without it). No database and no network: the session lookup is a stub of better-auth's getSession.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { API_DIR, apiRoutes } from "./security/api-routes";

interface StubSession {
  role: "owner" | "approver" | "viewer";
  storedMode: "live" | "replay";
}
const HOME = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
let current: StubSession | null = null;

const quiet = { error() {}, warn() {}, info() {}, debug() {}, child: () => quiet };
const fakeRuntime = {
  auth: {
    api: {
      getSession: async () =>
        current
          ? {
              user: {
                id: "3620553f-1d7b-4bbb-9f50-6bb3cd30368a",
                businessId: HOME,
                role: current.role,
              },
              session: { id: "11111111-1111-4111-8111-111111111111", mode: current.storedMode },
            }
          : null,
    },
  },
  // Any query fails: a guard that reached the database would show up as a non-403 answer.
  db: new Proxy(
    {},
    {
      get: () => () => {
        throw new Error("no database in this test");
      },
    },
  ),
  logger: quiet,
  settings: { secret: "x".repeat(32), baseURL: "http://localhost", production: false },
  now: () => new Date(),
};

vi.mock("../src/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/auth")>();
  return { ...actual, getAuthRuntime: () => fakeRuntime };
});

const MUTATING = /export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=/g;

/** Mutating routes a judge session never reaches through a session guard, each with its reason. */
const EXEMPT: Record<string, string> = {
  "webhooks/airwallex POST":
    "no session at all: HMAC over the raw body from Airwallex (ADR 0005); a judge cookie is ignored",
  "auth/[...all] POST":
    "sign-in and sign-out (better-auth); the judge must be able to sign in and out",
};

function mutatingRoutes(): { route: string; method: string }[] {
  const out: { route: string; method: string }[] = [];
  for (const route of apiRoutes()) {
    const source = readFileSync(join(API_DIR, route, "route.ts"), "utf8");
    for (const m of source.matchAll(MUTATING)) out.push({ route, method: m[1] as string });
    // `export const { GET, POST } = ...` (the better-auth handler).
    for (const m of source.matchAll(/export\s+const\s+\{([^}]+)\}\s*=/g)) {
      for (const name of (m[1] as string).split(",").map((s) => s.trim())) {
        if (/^(POST|PUT|PATCH|DELETE)$/.test(name)) out.push({ route, method: name });
      }
    }
  }
  return out;
}

const ROUTES = mutatingRoutes();

function fakeParams(route: string): Record<string, string> {
  const params: Record<string, string> = {};
  for (const m of route.matchAll(/\[(\w+)\]/g)) {
    params[m[1] as string] = "00000000-0000-4000-8000-000000000000";
  }
  return params;
}

async function call(route: string, method: string, init: RequestInit = {}, url = "") {
  const mod = (await import(join(API_DIR, route, "route.ts"))) as Record<
    string,
    (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
  >;
  const handler = mod[method];
  if (!handler) throw new Error(`${route} has no ${method}`);
  const req = new Request(`http://localhost/api/${route}${url}`, {
    method,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: "{}",
  });
  return handler(req, { params: Promise.resolve(fakeParams(route)) });
}

beforeEach(() => {
  current = { role: "viewer", storedMode: "replay" };
});

describe("the route table", () => {
  it("finds the mutating routes (the scan works)", () => {
    expect(ROUTES.length).toBeGreaterThan(20);
    expect(ROUTES).toContainEqual({ route: "v1/session/mode", method: "PUT" });
  });

  it("every exemption still exists", () => {
    const keys = ROUTES.map((r) => `${r.route} ${r.method}`);
    for (const key of Object.keys(EXEMPT)) expect(keys).toContain(key);
  });

  it("only the owner's mode switch may mutate from replay (allowInReplay)", () => {
    const allowed = apiRoutes().filter((r) =>
      readFileSync(join(API_DIR, r, "route.ts"), "utf8").includes("allowInReplay: true"),
    );
    expect(allowed).toEqual(["v1/session/mode"]);
    const source = readFileSync(join(API_DIR, "v1/session/mode/route.ts"), "utf8");
    expect(source).toMatch(/auth: \{ roles: \["owner"\] \}/);
  });
});

describe("the judge gets 403 on every mutating route", () => {
  for (const { route, method } of ROUTES) {
    const key = `${route} ${method}`;
    if (key in EXEMPT) continue;
    it(key, async () => {
      const res = await call(route, method);
      expect(res.status, await res.clone().text()).toBe(403);
    });
  }
});

describe("an owner session in replay mode is read-only too", () => {
  for (const { route, method } of ROUTES) {
    const key = `${route} ${method}`;
    if (key in EXEMPT || key === "v1/session/mode PUT") continue;
    it(key, async () => {
      current = { role: "owner", storedMode: "replay" };
      const res = await call(route, method);
      expect(res.status).toBe(403);
    });
  }
});

describe("the judge cannot reach live by tampering", () => {
  it("a session row that says live is still replay for the judge", async () => {
    current = { role: "viewer", storedMode: "live" };
    const { sessionCtx } = await import("../src/lib/authz");
    const ctx = await sessionCtx(fakeRuntime as never, new Headers());
    expect(ctx?.mode).toBe("replay");
    // No recording loaded (no database here): read-only on the judge's own business.
    expect(ctx?.businessId).toBe(HOME);
  });

  it("cookie, query and header values do not change the mode", async () => {
    current = { role: "viewer", storedMode: "live" };
    const { sessionCtx } = await import("../src/lib/authz");
    const headers = new Headers({
      cookie: "carnet.mode=live; mode=live",
      "x-carnet-mode": "live",
      "x-mode": "live",
    });
    const ctx = await sessionCtx(fakeRuntime as never, headers);
    expect(ctx?.mode).toBe("replay");
    const res = await call(
      "v1/session/mode",
      "PUT",
      { headers: { "x-carnet-mode": "live" } },
      "?mode=live",
    );
    expect(res.status).toBe(403);
  });

  it("the judge's switch to live is refused (403), the approver's too", async () => {
    for (const role of ["viewer", "approver"] as const) {
      current = { role, storedMode: role === "viewer" ? "replay" : "live" };
      const res = await call("v1/session/mode", "PUT");
      expect(res.status).toBe(403);
    }
  });

  it("the owner's live session reads the owner's own business", async () => {
    current = { role: "owner", storedMode: "live" };
    const { sessionCtx } = await import("../src/lib/authz");
    const ctx = await sessionCtx(fakeRuntime as never, new Headers());
    expect(ctx?.mode).toBe("live");
    expect(ctx?.businessId).toBe(HOME);
  });
});
