import { describe, expect, it } from "vitest";
import { appVersion, healthPayload, probeDb } from "./health";

const now = new Date("2026-11-02T00:00:00Z");

describe("healthPayload", () => {
  it("is 200 with db ok", () => {
    expect(healthPayload("ok", "abc123", now)).toEqual({
      httpStatus: 200,
      body: { status: "ok", version: "abc123", db: "ok", time: "2026-11-02T00:00:00.000Z" },
    });
  });

  it("is 503 when the database is unreachable or unconfigured", () => {
    expect(healthPayload("unreachable", "v", now).httpStatus).toBe(503);
    expect(healthPayload("unreachable", "v", now).body.status).toBe("unavailable");
    expect(healthPayload("unconfigured", "v", now).httpStatus).toBe(503);
  });
});

describe("probeDb", () => {
  it("reports ok, unreachable, unconfigured and timeouts", async () => {
    expect(await probeDb(async () => 1)).toBe("ok");
    expect(await probeDb(async () => Promise.reject(new Error("ECONNREFUSED")))).toBe(
      "unreachable",
    );
    expect(await probeDb(null)).toBe("unconfigured");
    expect(await probeDb(() => new Promise(() => {}), 20)).toBe("unreachable");
  });
});

describe("appVersion", () => {
  it("prefers the platform commit, then APP_VERSION, then dev", () => {
    expect(appVersion({ RENDER_GIT_COMMIT: "0123456789abcdef", APP_VERSION: "x" })).toBe(
      "0123456789ab",
    );
    expect(appVersion({ APP_VERSION: "1.2.3" })).toBe("1.2.3");
    expect(appVersion({})).toBe("dev");
  });
});
