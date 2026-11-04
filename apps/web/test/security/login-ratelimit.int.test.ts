// Login limiter hardening (BL-01 6629243041, fixed in M1-10): the count is taken first, atomically,
// so concurrent failures cannot overshoot the per-email limit; and the per-IP key uses the entry the
// trusted proxy appended to X-Forwarded-For, so a client-chosen first hop cannot rotate it.
import { schema, windowStartOf } from "@carnet/db";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { clientIp, LOGIN_RATE_LIMITS, loginRateLimitKeys } from "../../src/lib/ratelimit";
import { jsonRequest, setupAuthTestEnv, signIn } from "../auth/setup";

const env = setupAuthTestEnv();
const WINDOW = LOGIN_RATE_LIMITS.email.windowMs;

async function counter(key: string, at: Date): Promise<number> {
  const rows = await env()
    .db.select({ count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(
      and(
        eq(schema.rateLimits.key, key),
        eq(schema.rateLimits.windowStart, windowStartOf(at, WINDOW)),
      ),
    );
  return rows[0]?.count ?? 0;
}

describe("per-email limit under concurrency", () => {
  it("20 concurrent wrong-password attempts: exactly 5 are tried (401), 15 refused (429)", async () => {
    const start = new Date(Math.floor(Date.now() / WINDOW) * WINDOW + 20 * WINDOW + 30_000);
    env().setNow(start);
    const email = "approver@carnet.example";
    const statuses = (
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          signIn(env(), email, `wrong-${i}`, `192.0.2.${100 + i}`),
        ),
      )
    ).map((r) => r.status);
    expect(statuses.filter((s) => s === 401)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(15);
    // Refused attempts give their hit back: the counter holds the 5 real failures.
    expect(await counter(loginRateLimitKeys(email, "x").email, start)).toBe(5);
  });

  it("a successful sign-in does not count against the email", async () => {
    const start = new Date(Math.floor(Date.now() / WINDOW) * WINDOW + 30 * WINDOW);
    env().setNow(start);
    for (let i = 0; i < 6; i++) {
      const res = await signIn(env(), "owner@carnet.example", env().passwords.owner, "192.0.2.250");
      expect(res.status).toBe(200);
    }
    expect(await counter(loginRateLimitKeys("owner@carnet.example", "x").email, start)).toBe(0);
  });
});

describe("client IP from X-Forwarded-For", () => {
  const req = (xff: string | null) =>
    new Request("http://localhost/x", { headers: xff === null ? {} : { "x-forwarded-for": xff } });

  it("takes the entry the trusted proxy appended, not the client-chosen first hop", () => {
    expect(clientIp(req("6.6.6.6, 203.0.113.9"), 1)).toBe("203.0.113.9");
    expect(clientIp(req("6.6.6.6, 203.0.113.9, 10.0.0.2"), 2)).toBe("203.0.113.9");
    expect(clientIp(req("203.0.113.9"), 1)).toBe("203.0.113.9");
    // Shorter than the hop count: the request skipped a proxy; use the leftmost.
    expect(clientIp(req("203.0.113.9"), 2)).toBe("203.0.113.9");
    // No proxy configured: the header is ignored.
    expect(clientIp(req("6.6.6.6"), 0)).toBe("unknown");
    expect(clientIp(req(null), 1)).toBe("unknown");
  });

  it("rotating a spoofed first hop does not reset the per-IP counter", async () => {
    const start = new Date(Math.floor(Date.now() / WINDOW) * WINDOW + 40 * WINDOW);
    env().setNow(start);
    const statuses: number[] = [];
    for (let i = 1; i <= 21; i++) {
      const request = jsonRequest(
        "/api/auth/sign-in/email",
        { email: `nobody-${i}@carnet.example`, password: "wrong" },
        { ip: `10.${i}.0.1, 198.51.100.200` },
      );
      statuses.push((await env().handlers.POST(request)).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
