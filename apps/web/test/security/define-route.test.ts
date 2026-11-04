// defineRoute input validation and error mapping (M1-10 AC 3 and AC 8). No database: the guards are a
// stub Authz (a header names the role), and no route here is rate limited.
import type { RepoCtx } from "@carnet/db";
import { ApiErrorSchema, type BusinessId, type UserId } from "@carnet/domain";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AuthCtx, Authz, Role } from "../../src/lib/authz";
import {
  assertStrictSchema,
  createRouteKit,
  DEFAULT_MAX_JSON_BODY_BYTES,
  MAX_BODY_BYTES,
  maxJsonBodyBytes,
} from "../../src/lib/define-route";
import { forbidden, unauthenticated } from "../../src/lib/errors";

const BUSINESS = "00000000-0000-4000-8000-000000000001" as BusinessId;
const USER = "00000000-0000-4000-8000-000000000002" as UserId;

/** Role from the `x-test-role` header; no header = no session. Same viewer rule as M1-04. */
const stubAuthz: Authz = {
  async requireSession(req) {
    const role = req.headers.get("x-test-role") as Role | null;
    if (!role) throw unauthenticated();
    if (role === "viewer" && req.method !== "GET") throw forbidden();
    return { businessId: BUSINESS, userId: USER, role } satisfies AuthCtx;
  },
  requireRole(...roles) {
    return async (req) => {
      const ctx = await stubAuthz.requireSession(req);
      if (!roles.includes(ctx.role)) throw forbidden();
      return ctx;
    };
  },
  repo: (ctx) => ({ businessId: ctx.businessId }) as unknown as RepoCtx,
  guarded: () => {
    throw new Error("not used");
  },
};

const errors: Record<string, unknown>[] = [];
const kit = createRouteKit({
  authz: stubAuthz,
  db: () => {
    throw new Error("no database in this test");
  },
  logger: () =>
    ({ error: (obj) => errors.push(obj) }) as { error(o: Record<string, unknown>): void },
  now: () => new Date(),
});

const Body = z.strictObject({
  reference: z.string().min(1).max(140),
  amount: z.strictObject({ minor: z.string().regex(/^\d+$/), currency: z.enum(["USD", "EUR"]) }),
});

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/v1/things", {
    method: "POST",
    headers: { "content-type": "application/json", "x-test-role": "owner", ...headers },
    body,
  });
}

async function apiError(res: Response) {
  const json: unknown = await res.json();
  return ApiErrorSchema.parse(json).error;
}

describe("defineRoute input validation", () => {
  const handler = vi.fn(async () => Response.json({ ok: true }));
  const route = kit.defineRoute({ method: "POST", auth: "session", body: Body, handler });

  const valid = JSON.stringify({ reference: "INV-1", amount: { minor: "100", currency: "USD" } });

  it("passes typed, validated input to the handler", async () => {
    handler.mockClear();
    const res = await route(post(valid));
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("invalid body: 400 VALIDATION_FAILED with field paths, handler never called", async () => {
    handler.mockClear();
    const res = await route(
      post(JSON.stringify({ reference: "", amount: { minor: 12, currency: "GBP" } })),
    );
    expect(res.status).toBe(400);
    const err = await apiError(res);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.request_id).toBeTruthy();
    const issues = (err.details?.issues ?? []) as { location: string; path: string }[];
    expect(issues.map((i) => `${i.location}:${i.path}`).sort()).toEqual([
      "body:amount.currency",
      "body:amount.minor",
      "body:reference",
    ]);
    expect(handler).not.toHaveBeenCalled();
  });

  it("an unknown extra field is rejected (strict), at top level and nested", async () => {
    handler.mockClear();
    const res = await route(
      post(
        JSON.stringify({
          reference: "INV-1",
          amount: { minor: "1", currency: "USD", fx: true },
          isAdmin: true,
        }),
      ),
    );
    expect(res.status).toBe(400);
    const issues = ((await apiError(res)).details?.issues ?? []) as {
      path: string;
      code: string;
    }[];
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "isAdmin", code: "unrecognized_keys" }),
        expect.objectContaining({ path: "amount.fx", code: "unrecognized_keys" }),
      ]),
    );
    expect(handler).not.toHaveBeenCalled();
  });

  it("oversize body: 413 PAYLOAD_TOO_LARGE, by content-length and by streamed length", async () => {
    handler.mockClear();
    const small = kit.defineRoute({
      method: "POST",
      auth: "session",
      body: Body,
      maxBodyBytes: 64,
      handler,
    });
    const big = JSON.stringify({
      reference: "x".repeat(200),
      amount: { minor: "1", currency: "USD" },
    });
    const declared = await small(post(big, { "content-length": String(big.length) }));
    expect(declared.status).toBe(413);
    expect((await apiError(declared)).code).toBe("PAYLOAD_TOO_LARGE");
    // No content-length: the stream is cut off at the cap.
    const streamed = await small(
      new Request("http://localhost/api/v1/things", {
        method: "POST",
        headers: { "content-type": "application/json", "x-test-role": "owner" },
        body: new Blob([big]).stream(),
        duplex: "half",
      } as RequestInit),
    );
    expect(streamed.status).toBe(413);
    expect(handler).not.toHaveBeenCalled();
  });

  it("the default JSON cap comes from MAX_JSON_BODY_BYTES and never exceeds 5 MB", () => {
    expect(maxJsonBodyBytes({})).toBe(DEFAULT_MAX_JSON_BODY_BYTES);
    expect(maxJsonBodyBytes({ MAX_JSON_BODY_BYTES: "2048" })).toBe(2048);
    expect(maxJsonBodyBytes({ MAX_JSON_BODY_BYTES: String(50 * 1024 * 1024) })).toBe(
      MAX_BODY_BYTES,
    );
    expect(() =>
      kit.defineRoute({
        method: "POST",
        auth: "session",
        maxBodyBytes: MAX_BODY_BYTES + 1,
        handler,
      }),
    ).toThrow(/maxBodyBytes/);
  });

  it("wrong or missing content type: 415 UNSUPPORTED_MEDIA_TYPE", async () => {
    handler.mockClear();
    for (const type of ["text/plain", "application/x-www-form-urlencoded", ""]) {
      const req = new Request("http://localhost/api/v1/things", {
        method: "POST",
        headers: { "x-test-role": "owner", ...(type ? { "content-type": type } : {}) },
        body: valid,
      });
      if (!type) req.headers.delete("content-type");
      const res = await route(req);
      expect(res.status, type).toBe(415);
      expect((await apiError(res)).code).toBe("UNSUPPORTED_MEDIA_TYPE");
    }
    expect(
      (await route(post(valid, { "content-type": "application/json; charset=utf-8" }))).status,
    ).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("malformed JSON and an empty body are 400, handler never called", async () => {
    handler.mockClear();
    expect((await route(post("{not json"))).status).toBe(400);
    expect((await route(post(""))).status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a route without a body schema refuses a body", async () => {
    const noBody = vi.fn(async () => new Response(null, { status: 204 }));
    const r = kit.defineRoute({ method: "POST", auth: "session", handler: noBody });
    expect((await r(post(valid))).status).toBe(400);
    expect(noBody).not.toHaveBeenCalled();
    expect(
      (
        await r(
          new Request("http://localhost/x", {
            method: "POST",
            headers: { "x-test-role": "owner" },
          }),
        )
      ).status,
    ).toBe(204);
  });

  it("query and params are parsed with strict schemas and reported together", async () => {
    const h = vi.fn(async () => Response.json({}));
    const r = kit.defineRoute({
      method: "GET",
      auth: "session",
      query: z.strictObject({ limit: z.coerce.number().int().min(1).max(100).optional() }),
      params: z.strictObject({ id: z.uuid() }),
      handler: h,
    });
    const res = await r(
      new Request("http://localhost/api/v1/things/nope?limit=0&evil=1", {
        headers: { "x-test-role": "viewer" },
      }),
      { params: Promise.resolve({ id: "nope" }) },
    );
    expect(res.status).toBe(400);
    const issues = ((await apiError(res)).details?.issues ?? []) as {
      location: string;
      path: string;
    }[];
    expect(issues.map((i) => `${i.location}:${i.path}`).sort()).toEqual([
      "params:id",
      "query:evil",
      "query:limit",
    ]);
    expect(h).not.toHaveBeenCalled();
  });

  it("refuses a non-strict schema at definition time", () => {
    expect(() =>
      kit.defineRoute({
        method: "POST",
        auth: "session",
        body: z.object({ a: z.string() }),
        handler: async () => new Response(null),
      }),
    ).toThrow(/strictObject/);
    expect(() =>
      assertStrictSchema(z.strictObject({ inner: z.object({ b: z.string() }) }), "t"),
    ).toThrow(/inner/);
    expect(() =>
      assertStrictSchema(z.strictObject({ list: z.array(z.strictObject({})).optional() }), "t"),
    ).not.toThrow();
  });
});

describe("defineRoute authorisation (M1-04 guards)", () => {
  it("no session 401, viewer 403 on a mutation, role list enforced", async () => {
    const h = vi.fn(async () => Response.json({}));
    const approve = kit.defineRoute({
      method: "POST",
      auth: { roles: ["owner", "approver"] },
      handler: h,
    });
    const settings = kit.defineRoute({ method: "POST", auth: { roles: ["owner"] }, handler: h });
    const req = (role?: Role) =>
      new Request("http://localhost/x", {
        method: "POST",
        headers: role ? { "x-test-role": role } : {},
      });
    expect((await approve(req())).status).toBe(401);
    expect((await approve(req("viewer"))).status).toBe(403);
    expect((await approve(req("approver"))).status).toBe(200);
    expect((await settings(req("approver"))).status).toBe(403);
    expect((await settings(req("owner"))).status).toBe(200);
    expect(h).toHaveBeenCalledTimes(2);
  });

  it("checks authorisation before input: an anonymous caller learns nothing about the schema", async () => {
    const r = kit.defineRoute({
      method: "POST",
      auth: "session",
      body: Body,
      handler: async () => Response.json({}),
    });
    const res = await r(
      new Request("http://localhost/x", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(401);
    expect((await apiError(res)).details).toBeUndefined();
  });
});

describe("500 never leaks internals", () => {
  it("a thrown error with SQL text and a stack becomes a bare INTERNAL", async () => {
    errors.length = 0;
    const r = kit.defineRoute({
      method: "GET",
      auth: "public",
      handler: async () => {
        const e = new Error(
          'duplicate key value violates unique constraint "payments_pkey": INSERT INTO payments (id, business_id) VALUES ($1, $2)',
        );
        e.stack = `${e.message}\n    at secretFunction (/app/src/lib/secret.ts:12:3)`;
        throw e;
      },
    });
    const res = await r(new Request("http://localhost/x"));
    expect(res.status).toBe(500);
    const text = await res.text();
    const body = ApiErrorSchema.parse(JSON.parse(text));
    expect(body.error).toMatchObject({ code: "INTERNAL", message: "Something went wrong." });
    expect(body.error.details).toBeUndefined();
    for (const leak of ["INSERT", "payments", "constraint", "secret.ts", "    at ", "stack"]) {
      expect(text).not.toContain(leak);
    }
    expect(res.headers.get("x-request-id")).toBe(body.error.request_id);
    // The class and message reach the server log only.
    expect(errors).toEqual([
      expect.objectContaining({
        event: "route.error",
        errClass: "Error",
        requestId: body.error.request_id,
      }),
    ]);
  });

  it("every code in the error enum maps to its status in the one format", async () => {
    const { HttpProblem } = await import("../../src/lib/errors");
    const cases = [
      ["VALIDATION_FAILED", 400],
      ["UNAUTHENTICATED", 401],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["CONFLICT", 409],
      ["PAYLOAD_TOO_LARGE", 413],
      ["UNSUPPORTED_MEDIA_TYPE", 415],
      ["RATE_LIMITED", 429],
    ] as const;
    for (const [code, status] of cases) {
      const r = kit.defineRoute({
        method: "GET",
        auth: "public",
        handler: async () => {
          throw new HttpProblem(code, "nope");
        },
      });
      const res = await r(new Request("http://localhost/x"));
      expect(res.status, code).toBe(status);
      expect((await apiError(res)).code).toBe(code);
    }
  });
});
