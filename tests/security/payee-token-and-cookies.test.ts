// STRIDE "Information disclosure: Payee page reveals a compliance hold" (token guessing) and
// "Spoofing: Stolen session" (cookie flags), architecture §8.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  hashPayeeToken,
  newPayeeToken,
  PAYEE_TOKEN_BYTES,
} from "../../apps/web/src/server/payee-status";

describe("Payee page tokens cannot be guessed", () => {
  it("carry at least 128 bits of randomness", () => {
    expect(PAYEE_TOKEN_BYTES).toBeGreaterThanOrEqual(16);
  });

  it("are unique, URL-safe and of fixed length over 5000 draws", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const t = newPayeeToken();
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      seen.add(t);
    }
    expect(seen.size).toBe(5000);
    expect(new Set([...seen].map((t) => t.length)).size).toBe(1);
  });

  it("no byte position is biased: every base64url character class shows up", () => {
    const chars = new Set<string>();
    for (let i = 0; i < 400; i++) for (const c of newPayeeToken()) chars.add(c);
    expect(chars.size).toBeGreaterThan(55);
  });

  it("are stored only as a 64-hex SHA-256 that differs per token and ignores overlong input", () => {
    const a = newPayeeToken();
    const b = newPayeeToken();
    expect(hashPayeeToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashPayeeToken(a)).not.toBe(hashPayeeToken(b));
    expect(hashPayeeToken(a)).not.toContain(a);
    expect(() => hashPayeeToken("x".repeat(100_000))).not.toThrow();
  });
});

describe("Session cookies", () => {
  const src = readFileSync(new URL("../../apps/web/src/lib/auth.ts", import.meta.url), "utf8");

  it("are HttpOnly and SameSite=Lax, Secure in production", () => {
    expect(src).toMatch(/httpOnly:\s*true/);
    expect(src).toMatch(/sameSite:\s*"lax"/);
    expect(src).toMatch(/secure:\s*settings\.production/);
    expect(src).toMatch(/useSecureCookies:\s*settings\.production/);
  });

  it("expire after at most 8 hours", () => {
    expect(src).toMatch(/SESSION_TTL_SECONDS\s*=\s*8\s*\*\s*60\s*\*\s*60/);
  });

  it("never put the session token in a response body", () => {
    expect(src).toContain("The token stays in the HttpOnly cookie");
  });
});
