import { describe, expect, it } from "vitest";
import { healthPayload } from "./health";

describe("healthPayload", () => {
  it("reports ok with an ISO timestamp", () => {
    expect(healthPayload(new Date("2026-11-02T00:00:00Z"))).toEqual({
      status: "ok",
      time: "2026-11-02T00:00:00.000Z",
    });
  });
});
