// verifyWebhook over the recorded M0-05 deliveries (fixtures/airwallex/webhooks/). The real secret is
// not in the repo, so each delivery is re-signed with a test secret over its recorded x-timestamp and
// raw body (the construction the recorded signatures verified with in M0-05: 25 of 25).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { computeWebhookSignature, parseWebhookEvent, verifyWebhook } from "../src/index";
import { blockedCalls, loadWebhook, webhookNames } from "./fixture-loader";

const SECRET = "whsec-test-only-0001";
const names = webhookNames();
const first = loadWebhook("rfi.action_required.1");
const ts = first.headers["x-timestamp"] ?? "";
const raw = Buffer.from(first.body_utf8, "utf8");
const at = Number(ts);
const sig = computeWebhookSignature(SECRET, ts, raw);

afterAll(() => {
  expect(blockedCalls).toEqual([]);
});

describe("verifyWebhook", () => {
  it("has the recorded deliveries", () => {
    expect(names.length).toBe(25);
    expect(first.headers["x-signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(ts).toMatch(/^\d{13}$/); // epoch milliseconds
  });

  it.each(names)("accepts a fixture-derived valid signature: %s", (name) => {
    const d = loadWebhook(name);
    const t = d.headers["x-timestamp"] ?? "";
    const body = Buffer.from(d.body_utf8, "utf8");
    const signature = computeWebhookSignature(SECRET, t, body);
    const now = Date.parse(d.received_at);
    expect(verifyWebhook({ rawBody: body, timestamp: t, signature, secret: SECRET, now })).toEqual({
      ok: true,
    });
    expect(parseWebhookEvent(body).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("accepts the raw body as a string too", () => {
    expect(
      verifyWebhook({
        rawBody: first.body_utf8,
        timestamp: ts,
        signature: sig,
        secret: SECRET,
        now: at,
      }),
    ).toEqual({ ok: true });
  });

  it("rejects a tampered body", () => {
    const tampered = Buffer.from(raw);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 1;
    expect(
      verifyWebhook({ rawBody: tampered, timestamp: ts, signature: sig, secret: SECRET, now: at }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a wrong secret", () => {
    expect(
      verifyWebhook({ rawBody: raw, timestamp: ts, signature: sig, secret: "other", now: at }),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a 6-minute-old timestamp (validly signed)", () => {
    const old = String(at - 6 * 60_000);
    const s = computeWebhookSignature(SECRET, old, raw);
    expect(
      verifyWebhook({ rawBody: raw, timestamp: old, signature: s, secret: SECRET, now: at }),
    ).toEqual({ ok: false, reason: "stale" });
    // 4m59s is still fresh
    const ok = String(at - (5 * 60_000 - 1_000));
    expect(
      verifyWebhook({
        rawBody: raw,
        timestamp: ok,
        signature: computeWebhookSignature(SECRET, ok, raw),
        secret: SECRET,
        now: at,
      }).ok,
    ).toBe(true);
  });

  it("rejects a timestamp more than 1 minute in the future", () => {
    const future = String(at + 61_000);
    const s = computeWebhookSignature(SECRET, future, raw);
    expect(
      verifyWebhook({ rawBody: raw, timestamp: future, signature: s, secret: SECRET, now: at }),
    ).toEqual({ ok: false, reason: "future" });
  });

  it("rejects odd-length, non-hex, empty and missing signatures without throwing", () => {
    for (const bad of [sig.slice(0, 63), `${sig}0`, "zz".repeat(32), "", undefined, null]) {
      expect(() =>
        verifyWebhook({ rawBody: raw, timestamp: ts, signature: bad, secret: SECRET, now: at }),
      ).not.toThrow();
      expect(
        verifyWebhook({ rawBody: raw, timestamp: ts, signature: bad, secret: SECRET, now: at }).ok,
      ).toBe(false);
    }
  });

  it("rejects a malformed or missing timestamp", () => {
    for (const bad of ["abc", "", undefined, "1793772318256.5"]) {
      expect(
        verifyWebhook({ rawBody: raw, timestamp: bad, signature: sig, secret: SECRET, now: at }),
      ).toEqual({ ok: false, reason: "malformed_timestamp" });
    }
  });

  it("compares with crypto.timingSafeEqual (grep test)", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/webhook.ts", import.meta.url)), "utf8");
    expect(src).toMatch(/import \{[^}]*timingSafeEqual[^}]*\} from "node:crypto"/);
    expect(src).toMatch(/timingSafeEqual\(given, expected\)/);
    expect(src).not.toMatch(/signature\s*===|===\s*signature/);
  });
});

describe("parseWebhookEvent", () => {
  it("rfi.* carries only {id, type}: the RFI must be fetched", () => {
    const e = parseWebhookEvent(raw);
    expect(e.name).toBe("rfi.action_required");
    expect(Object.keys(e.data).sort()).toEqual(["id", "type"]);
    expect(e.objectId).toBe(e.data.id);
  });

  it("payout.transfer.* carries the transfer object (id, status)", () => {
    const d = loadWebhook("payout.transfer.paid.1");
    const e = parseWebhookEvent(d.body_utf8);
    expect(e.name).toBe("payout.transfer.paid");
    expect(e.data.status).toBe("PAID");
    expect(typeof e.objectId).toBe("string");
  });
});
