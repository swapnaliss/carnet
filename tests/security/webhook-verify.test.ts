// STRIDE "Spoofing: Forged Airwallex webhook" (architecture §8): the verifier's rejection matrix.
// The route behaviour (dedupe, no state change, 413, 429) is in apps/web/test/webhooks/route.int.test.ts.
import { readFileSync } from "node:fs";
import {
  computeWebhookSignature,
  verifyWebhook,
  WEBHOOK_MAX_AGE_MS,
  WEBHOOK_MAX_FUTURE_MS,
} from "@carnet/airwallex";
import { describe, expect, it } from "vitest";

const SECRET = "whsec_canary_not_a_real_secret";
const NOW = 1_800_000_000_000;
const BODY = JSON.stringify({ id: "evt_1", name: "rfi.created", data: { id: "rfi_1" } });
const ts = (offset = 0) => String(NOW + offset);
const sign = (t: string, body: string = BODY) => computeWebhookSignature(SECRET, t, body);
const verify = (over: Partial<Parameters<typeof verifyWebhook>[0]> = {}) =>
  verifyWebhook({
    rawBody: BODY,
    timestamp: ts(),
    signature: sign(ts()),
    secret: SECRET,
    now: NOW,
    ...over,
  });

describe("Spoofing: forged Airwallex webhook", () => {
  it("accepts a correctly signed, fresh delivery", () => {
    expect(verify()).toEqual({ ok: true });
  });

  it("rejects a forged signature", () => {
    expect(verify({ signature: "a".repeat(64) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a signature over a modified body", () => {
    expect(verify({ rawBody: BODY.replace("rfi_1", "rfi_2") })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature made with another secret", () => {
    const other = computeWebhookSignature("another-secret", ts(), BODY);
    expect(verify({ signature: other })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it.each([
    ["missing signature", { signature: null }],
    ["missing timestamp", { timestamp: null }],
    ["both headers missing", { signature: undefined, timestamp: undefined }],
    ["empty signature", { signature: "" }],
    ["short signature", { signature: "abc" }],
    ["non-hex signature", { signature: "z".repeat(64) }],
    ["overlong signature", { signature: sign(ts()) + "00" }],
  ])("rejects %s", (_label, over) => {
    expect(verify(over).ok).toBe(false);
  });

  it.each(["", "abc", "-1", "1.5", "1e12", " 1800000000000", "9".repeat(20)])(
    "rejects the malformed timestamp %j",
    (bad) => {
      const r = verify({ timestamp: bad, signature: sign(bad) });
      expect(r).toEqual({ ok: false, reason: "malformed_timestamp" });
    },
  );

  it("rejects a timestamp more than 5 minutes old (correctly signed)", () => {
    const t = ts(-(WEBHOOK_MAX_AGE_MS + 1));
    expect(verify({ timestamp: t, signature: sign(t) })).toEqual({ ok: false, reason: "stale" });
  });

  it("accepts a timestamp exactly 5 minutes old", () => {
    const t = ts(-WEBHOOK_MAX_AGE_MS);
    expect(verify({ timestamp: t, signature: sign(t) })).toEqual({ ok: true });
  });

  it("rejects a future-dated timestamp (correctly signed)", () => {
    const t = ts(WEBHOOK_MAX_FUTURE_MS + 1);
    expect(verify({ timestamp: t, signature: sign(t) })).toEqual({ ok: false, reason: "future" });
  });

  it("a signature for one timestamp does not verify under another", () => {
    expect(verify({ timestamp: ts(1), signature: sign(ts()) }).ok).toBe(false);
  });

  it("verifies over raw bytes: re-serialised JSON with the same meaning is rejected", () => {
    const pretty = JSON.stringify(JSON.parse(BODY), null, 2);
    expect(verify({ rawBody: pretty }).ok).toBe(false);
    expect(verify({ rawBody: new TextEncoder().encode(BODY) })).toEqual({ ok: true });
  });

  it("compares in constant time and never with ===", () => {
    const src = readFileSync(
      new URL("../../packages/airwallex/src/webhook.ts", import.meta.url),
      "utf8",
    );
    expect(src).toContain("timingSafeEqual");
    expect(src).not.toMatch(/signature\s*(===|!==|==)\s*expected|expected\s*(===|!==)/);
  });

  it("the route verifies before it parses and stores only after a verdict", () => {
    const src = readFileSync(
      new URL("../../apps/web/src/app/api/webhooks/airwallex/route.ts", import.meta.url),
      "utf8",
    );
    const verifyAt = src.indexOf("verifyWebhook(");
    const storeAt = src.indexOf("storeVerifiedWebhook(raw");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(storeAt).toBeGreaterThan(verifyAt);
    expect(src).not.toMatch(/JSON\.parse|\.json\(\)/);
  });
});
