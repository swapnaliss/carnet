import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  apiError,
  ERROR_CODES,
  ERROR_HTTP_STATUS,
  httpStatusOf,
  IsoTimestampSchema,
  newRequestId,
  PageQuerySchema,
  PaymentIdSchema,
  pageSchema,
} from "../src/index";

describe("API error format", () => {
  it.each(ERROR_CODES)("%s serialises to the documented shape", (code) => {
    const err = apiError(code, "Something went wrong.", "req_123");
    const wire = JSON.parse(JSON.stringify(err));
    expect(wire).toEqual({
      error: { code, message: "Something went wrong.", request_id: "req_123" },
    });
    expect(ApiErrorSchema.parse(wire)).toEqual(wire);
    expect(httpStatusOf(code)).toBeGreaterThanOrEqual(400);
  });

  it("carries details when given", () => {
    const wire = JSON.parse(
      JSON.stringify(apiError("VALIDATION_FAILED", "Bad input.", "r1", { field: "amount" })),
    );
    expect(wire.error.details).toEqual({ field: "amount" });
    expect(ApiErrorSchema.safeParse(wire).success).toBe(true);
  });

  it("the code set is closed and every code has a status", () => {
    expect(ERROR_CODES.length).toBe(Object.keys(ERROR_HTTP_STATUS).length);
    expect(new Set(Object.values(ERROR_HTTP_STATUS)).size).toBe(ERROR_CODES.length);
  });

  it.each([
    ["unknown code", { error: { code: "TEAPOT", message: "m", request_id: "r" } }],
    ["lowercase code", { error: { code: "not_found", message: "m", request_id: "r" } }],
    ["missing request_id", { error: { code: "NOT_FOUND", message: "m" } }],
    ["empty request_id", { error: { code: "NOT_FOUND", message: "m", request_id: "" } }],
    ["missing message", { error: { code: "NOT_FOUND", request_id: "r" } }],
    ["empty message", { error: { code: "NOT_FOUND", message: "", request_id: "r" } }],
    [
      "details not an object",
      { error: { code: "NOT_FOUND", message: "m", request_id: "r", details: "x" } },
    ],
    [
      "extra key inside",
      { error: { code: "NOT_FOUND", message: "m", request_id: "r", stack: "s" } },
    ],
    [
      "extra key outside",
      { error: { code: "NOT_FOUND", message: "m", request_id: "r" }, ok: false },
    ],
    ["not wrapped", { code: "NOT_FOUND", message: "m", request_id: "r" }],
    ["null", null],
  ])("rejects %s", (_name, value) => {
    expect(ApiErrorSchema.safeParse(value).success).toBe(false);
  });
});

describe("base schemas", () => {
  it("id schemas accept UUIDs and reject anything else", () => {
    const id = newRequestId();
    expect(PaymentIdSchema.parse(id)).toBe(id);
    for (const bad of ["", "pay_1", "123", `${id}x`]) {
      expect(PaymentIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("ISO timestamps need an offset in ±hh:mm or Z form", () => {
    expect(IsoTimestampSchema.safeParse("2026-11-04T06:06:19Z").success).toBe(true);
    expect(IsoTimestampSchema.safeParse("2026-11-04T06:06:19.123+08:00").success).toBe(true);
    expect(IsoTimestampSchema.safeParse("2026-11-04").success).toBe(false);
    expect(IsoTimestampSchema.safeParse("2026-11-04T06:06:19").success).toBe(false);
    expect(IsoTimestampSchema.safeParse("yesterday").success).toBe(false);
  });

  it("page query defaults and bounds the limit; cursors are opaque base64url", () => {
    expect(PageQuerySchema.parse({})).toEqual({ limit: 25 });
    expect(PageQuerySchema.parse({ limit: "50", cursor: "abc_-1" })).toEqual({
      limit: 50,
      cursor: "abc_-1",
    });
    expect(PageQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ cursor: "a b" }).success).toBe(false);
    expect(PageQuerySchema.safeParse({ cursor: "../x" }).success).toBe(false);
  });

  it("pageSchema wraps items with a nullable next cursor", () => {
    const s = pageSchema(PaymentIdSchema);
    const id = newRequestId();
    expect(s.parse({ items: [id], next_cursor: null })).toEqual({ items: [id], next_cursor: null });
    expect(s.safeParse({ items: ["nope"], next_cursor: null }).success).toBe(false);
  });
});
