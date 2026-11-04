import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_ATTEMPTS, retryDelayMs } from "../../src/worker/backoff";

describe("retryDelayMs (equal jitter)", () => {
  it("doubles per attempt within [cap/2, cap]", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const cap = 1000 * 2 ** (attempt - 1);
      expect(retryDelayMs(attempt, { random: () => 0 })).toBe(cap / 2);
      expect(retryDelayMs(attempt, { random: () => 1 })).toBe(cap);
    }
  });

  it("the worst draw of attempt n+1 is never below the best draw of attempt n", () => {
    // up to the 10-minute cap (attempt 10 = 512 s); past it every delay is in [300 s, 600 s]
    for (let attempt = 1; attempt < 10; attempt++) {
      expect(retryDelayMs(attempt + 1, { random: () => 0 })).toBeGreaterThanOrEqual(
        retryDelayMs(attempt, { random: () => 1 }),
      );
    }
  });

  it("is capped at the maximum", () => {
    expect(retryDelayMs(40, { random: () => 1, maxMs: 60_000 })).toBe(60_000);
    expect(retryDelayMs(40, { random: () => 0, maxMs: 60_000 })).toBe(30_000);
  });

  it("defaults: 8 attempts, about 4.25 minutes of waiting at most before DEAD", () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(8);
    let total = 0;
    for (let a = 1; a < DEFAULT_MAX_ATTEMPTS; a++) total += retryDelayMs(a, { random: () => 1 });
    expect(total).toBe(127_000);
  });
});
