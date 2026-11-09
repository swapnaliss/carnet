// Payee link token, TTL and request-shape rules (M3-06) that need no database.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CreatePayeeLinkBodySchema, payeeLinkSpecs } from "../../../../server/payee-links-routes";
import {
  defaultPayeeLinkTtlHours,
  hashPayeeToken,
  MAX_PAYEE_LINK_TTL_HOURS,
  newPayeeToken,
  PAYEE_TOKEN_LENGTH,
  payeeStatusRateLimit,
} from "../../../../server/payee-status";

describe("token", () => {
  it("is 43 base64url characters (256 bits) and different every time", () => {
    const tokens = new Set(Array.from({ length: 200 }, newPayeeToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens)
      expect(token).toMatch(new RegExp(`^[A-Za-z0-9_-]{${PAYEE_TOKEN_LENGTH}}$`));
    expect(PAYEE_TOKEN_LENGTH).toBe(43);
  });

  it("hashes to the SHA-256 hex of the token: 64 lower-case hex characters", () => {
    const token = newPayeeToken();
    const hash = hashPayeeToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(hash).not.toContain(token);
  });

  it("cuts an oversized input before hashing", () => {
    expect(hashPayeeToken("a".repeat(5000))).toBe(hashPayeeToken("a".repeat(256)));
  });
});

describe("expiry and rate-limit settings", () => {
  it("PAYEE_LINK_TTL_HOURS defaults to 72 and never exceeds 30 days", () => {
    expect(defaultPayeeLinkTtlHours({})).toBe(72);
    expect(defaultPayeeLinkTtlHours({ PAYEE_LINK_TTL_HOURS: "24" })).toBe(24);
    expect(defaultPayeeLinkTtlHours({ PAYEE_LINK_TTL_HOURS: "100000" })).toBe(
      MAX_PAYEE_LINK_TTL_HOURS,
    );
    expect(MAX_PAYEE_LINK_TTL_HOURS).toBe(720);
    expect(defaultPayeeLinkTtlHours({ PAYEE_LINK_TTL_HOURS: "nope" })).toBe(72);
  });

  it("PAYEE_STATUS_RATE_LIMIT_PER_MIN defaults to 30 per minute", () => {
    expect(payeeStatusRateLimit({})).toEqual({ limit: 30, windowMs: 60_000 });
    expect(payeeStatusRateLimit({ PAYEE_STATUS_RATE_LIMIT_PER_MIN: "5" })).toEqual({
      limit: 5,
      windowMs: 60_000,
    });
  });
});

describe("create body", () => {
  it("defaults the disclosure level to GENERIC", () => {
    expect(CreatePayeeLinkBodySchema.parse({}).disclosure_level).toBe("GENERIC");
  });
  it("accepts the opt-in level and 1..720 hours", () => {
    expect(
      CreatePayeeLinkBodySchema.parse({
        disclosure_level: "DELAYED_FOR_VERIFICATION",
        expires_in_hours: 720,
      }),
    ).toEqual({ disclosure_level: "DELAYED_FOR_VERIFICATION", expires_in_hours: 720 });
  });
  it("refuses more than 30 days, zero, fractions, unknown levels and unknown keys", () => {
    for (const bad of [
      { expires_in_hours: 721 },
      { expires_in_hours: 0 },
      { expires_in_hours: 1.5 },
      { disclosure_level: "FULL" },
      { amount: 1 },
    ]) {
      expect(CreatePayeeLinkBodySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("who may do what", () => {
  it("create and revoke need owner or approver; listing needs a session", () => {
    expect(payeeLinkSpecs.create.auth).toEqual({ roles: ["owner", "approver"] });
    expect(payeeLinkSpecs.revoke.auth).toEqual({ roles: ["owner", "approver"] });
    expect(payeeLinkSpecs.list.auth).toBe("session");
  });
});
