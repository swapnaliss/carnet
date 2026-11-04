// AC: the sixth failed login for one email within 15 minutes returns 429 with `retry-after`; a
// successful login on another email is unaffected; the counter is a row in `rate_limits`.
import { schema, windowStartOf } from "@carnet/db";
import { ApiErrorSchema } from "@carnet/domain";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { LOGIN_RATE_LIMITS, loginRateLimitKeys } from "../../src/lib/auth";
import { setupAuthTestEnv, signIn } from "./setup";

const env = setupAuthTestEnv();
const FIFTEEN_MINUTES = 15 * 60 * 1000;

async function counter(key: string, windowStart: Date): Promise<number | undefined> {
  const rows = await env()
    .db.select({ count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(and(eq(schema.rateLimits.key, key), eq(schema.rateLimits.windowStart, windowStart)));
  return rows[0]?.count;
}

describe("login rate limit (per email)", () => {
  // Fixed clock 1 minute into a window, so all attempts share it.
  const start = new Date(Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES + 60_000);

  it("five failures answer 401, the sixth answers 429 with retry-after", async () => {
    env().setNow(start);
    const email = "approver@carnet.example";
    for (let i = 1; i <= 5; i++) {
      // A different IP each time: this is the per-email counter, not the per-IP one.
      const res = await signIn(env(), email, `wrong-password-${i}`, `192.0.2.${i}`);
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    const sixth = await signIn(env(), email, "wrong-password-6", "192.0.2.6");
    expect(sixth.status).toBe(429);
    const retryAfter = Number(sixth.headers.get("retry-after"));
    expect(retryAfter).toBe((FIFTEEN_MINUTES - 60_000) / 1000);
    expect(ApiErrorSchema.parse(await sixth.json()).error.code).toBe("RATE_LIMITED");

    // Even the right password is refused while the window lasts.
    const right = await signIn(env(), email, env().passwords.approver, "192.0.2.7");
    expect(right.status).toBe(429);

    // The counter is a row in rate_limits (the email is stored hashed).
    const key = loginRateLimitKeys(email, "192.0.2.1").email;
    expect(key).not.toContain("approver");
    expect(await counter(key, windowStartOf(start, LOGIN_RATE_LIMITS.email.windowMs))).toBe(5);
  });

  it("a successful login on another email is unaffected", async () => {
    env().setNow(start);
    const res = await signIn(env(), "owner@carnet.example", env().passwords.owner, "192.0.2.8");
    expect(res.status).toBe(200);
  });

  it("the email can sign in again in the next window", async () => {
    env().setNow(new Date(start.getTime() + FIFTEEN_MINUTES));
    const res = await signIn(
      env(),
      "approver@carnet.example",
      env().passwords.approver,
      "192.0.2.9",
    );
    expect(res.status).toBe(200);
  });
});

describe("login rate limit (per IP)", () => {
  it("twenty failures from one IP refuse the twenty-first attempt, whatever the email", async () => {
    // A window of its own, far from the per-email test.
    const start = new Date(
      Math.floor(Date.now() / FIFTEEN_MINUTES) * FIFTEEN_MINUTES + 10 * FIFTEEN_MINUTES,
    );
    env().setNow(start);
    const ip = "198.51.100.77";
    for (let i = 1; i <= 20; i++) {
      const res = await signIn(env(), `unknown-${i}@carnet.example`, "wrong-password", ip);
      expect(res.status, `attempt ${i}`).toBe(401);
    }
    const next = await signIn(env(), "owner@carnet.example", env().passwords.owner, ip);
    expect(next.status).toBe(429);
    expect(next.headers.get("retry-after")).not.toBeNull();
    const key = loginRateLimitKeys("x", ip).ip;
    expect(await counter(key, windowStartOf(start, LOGIN_RATE_LIMITS.ip.windowMs))).toBe(20);

    // Another IP is not affected.
    const other = await signIn(
      env(),
      "owner@carnet.example",
      env().passwords.owner,
      "198.51.100.78",
    );
    expect(other.status).toBe(200);
  });
});
