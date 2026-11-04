// AC: a valid inbound x-request-id is echoed; a malformed one is replaced; the same id appears in the
// log line, the response header and the error body. Exercised on the webhook route (a bad signature
// answers 401 in the shared error format and logs the rejection; no database is touched).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { POST } from "../../src/app/api/webhooks/airwallex/route";
import { SAFE_REQUEST_ID, withRequestContext } from "../../src/lib/request-context";
import { setWebhookLogger } from "../../src/server/webhooks/airwallex";
import { TEST_WEBHOOK_SECRET, webhookRequest } from "../support";
import { capture, capturedLogger } from "./capture";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeAll(() => {
  process.env.AIRWALLEX_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
});
afterAll(() => setWebhookLogger(null));

async function rejected(requestId: string | null) {
  const c = capture();
  setWebhookLogger(capturedLogger(c, { process: "web", route: "webhooks.airwallex" }));
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-timestamp": String(Date.now()),
    "x-signature": "0".repeat(64),
  };
  if (requestId !== null) headers["x-request-id"] = requestId;
  const res = await POST(webhookRequest('{"id":"evt_x"}', headers));
  const body = (await res.json()) as { error: { code: string; request_id: string } };
  const logged = c.lines().find((l) => l.event === "webhook_rejected");
  return { res, body, logged };
}

describe("x-request-id", () => {
  it("echoes a valid inbound id in the header, the error body and the log line", async () => {
    const id = "req-2026-11-04.abc:123";
    const { res, body, logged } = await rejected(id);
    expect(res.status).toBe(401);
    expect(res.headers.get("x-request-id")).toBe(id);
    expect(body.error).toMatchObject({ code: "UNAUTHENTICATED", request_id: id });
    expect(logged?.request_id).toBe(id);
  });

  it.each([
    ["contains spaces and separators", "bad id; forged=1"],
    ["contains markup", "<script>alert(1)</script>"],
    ["is too short", "abc"],
    ["is too long", "a".repeat(129)],
  ])("replaces an id that %s with a new UUID used everywhere", async (_why, bad) => {
    const { res, body, logged } = await rejected(bad);
    const id = res.headers.get("x-request-id") ?? "";
    expect(id).toMatch(UUID);
    expect(id).not.toBe(bad);
    expect(body.error.request_id).toBe(id);
    expect(logged?.request_id).toBe(id);
  });

  it("assigns an id when none is sent", async () => {
    const { res, body } = await rejected(null);
    expect(res.headers.get("x-request-id")).toMatch(UUID);
    expect(body.error.request_id).toBe(res.headers.get("x-request-id"));
  });

  it("the safe pattern accepts ids up to 128 of [A-Za-z0-9._:-] and at least 8", () => {
    expect(SAFE_REQUEST_ID.test("a".repeat(128))).toBe(true);
    expect(SAFE_REQUEST_ID.test("abcdefg")).toBe(false);
    expect(SAFE_REQUEST_ID.test("abcd efgh")).toBe(false);
  });

  it("withRequestContext sets the header on a success response too", async () => {
    const handler = withRequestContext(async () => Response.json({ ok: true }));
    const res = await handler(
      new Request("http://localhost/x", { headers: { "x-request-id": "trace-12345678" } }),
    );
    expect(res.headers.get("x-request-id")).toBe("trace-12345678");
  });
});
