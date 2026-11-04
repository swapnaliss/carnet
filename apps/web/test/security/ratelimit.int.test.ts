// Rate limits through defineRoute (M1-10 AC 5): the approval rule (20 per minute per user, registered
// for M2-07) on a route built from the real guards and the real `rate_limits` table.
import { createDbClient, type DbClient } from "@carnet/db";
import { ApiErrorSchema } from "@carnet/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouteKit } from "../../src/lib/define-route";
import { APPROVAL_RATE_LIMIT } from "../../src/lib/ratelimit";
import { ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const N = APPROVAL_RATE_LIMIT.limit;

let now = new Date("2026-11-04T10:00:05.000Z");
let calls = 0;
let approve: (req: Request) => Promise<Response>;
const cookies = { owner: "", approver: "" };

beforeAll(async () => {
  const kit = createRouteKit({
    authz: env().authz,
    db: () => env().db,
    logger: () => env().rt.logger,
    now: () => now,
  });
  approve = kit.defineRoute({
    method: "POST",
    auth: { roles: ["owner", "approver"] },
    rateLimit: { name: "approval", by: "user" },
    handler: async () => {
      calls += 1;
      return Response.json({ ok: true });
    },
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", env().passwords.owner);
  cookies.approver = await sessionCookie(
    env(),
    "approver@carnet.example",
    env().passwords.approver,
  );
});

const post = (cookie: string) =>
  new Request(`${ORIGIN}/api/v1/approvals`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
  });

describe("approval rate limit (fixed window, per user)", () => {
  it(`the (N+1)th request in a window is 429 with retry-after (N = ${N})`, async () => {
    calls = 0;
    for (let i = 1; i <= N; i++)
      expect((await approve(post(cookies.owner))).status, `#${i}`).toBe(200);
    const res = await approve(post(cookies.owner));
    expect(res.status).toBe(429);
    // 10:00:05 in a one-minute window: 55 seconds left.
    expect(res.headers.get("retry-after")).toBe("55");
    const body = ApiErrorSchema.parse(await res.json());
    expect(body.error).toMatchObject({
      code: "RATE_LIMITED",
      details: { retry_after_seconds: 55 },
    });
    expect(calls).toBe(N);
  });

  it("counters are per subject: another user in the same window is unaffected", async () => {
    expect((await approve(post(cookies.approver))).status).toBe(200);
    expect((await approve(post(cookies.owner))).status).toBe(429);
  });

  it("a new window resets the count", async () => {
    now = new Date("2026-11-04T10:01:00.000Z");
    expect((await approve(post(cookies.owner))).status).toBe(200);
  });

  it("50 concurrent calls, as two parallel bursts over separate pools, never exceed N allowed", async () => {
    now = new Date("2026-11-04T11:00:00.000Z");
    const pools: DbClient[] = [];
    try {
      // Two independent connection pools, as two web instances would have.
      // The per-worker test database, with the app role's credentials from DATABASE_URL.
      const { rows } = await env().db.execute(sql`select current_database() as name`);
      const url = new URL(process.env.DATABASE_URL ?? "");
      url.pathname = `/${String((rows[0] as { name: string }).name)}`;
      const kits = [0, 1].map(() => {
        const client = createDbClient(url.toString(), { max: 10 });
        pools.push(client);
        return createRouteKit({
          authz: env().authz,
          db: () => client.db,
          logger: () => env().rt.logger,
          now: () => now,
        }).defineRoute({
          method: "POST",
          auth: { roles: ["owner", "approver"] },
          rateLimit: { name: "approval", by: "user" },
          handler: async () => Response.json({ ok: true }),
        });
      });
      const responses = await Promise.all(
        Array.from({ length: 50 }, (_, i) => (kits[i % 2] ?? approve)(post(cookies.owner))),
      );
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 200)).toHaveLength(N);
      expect(statuses.filter((s) => s === 429)).toHaveLength(50 - N);
    } finally {
      await Promise.all(pools.map((p) => p.close()));
    }
  });
});

afterAll(() => {
  now = new Date();
});
