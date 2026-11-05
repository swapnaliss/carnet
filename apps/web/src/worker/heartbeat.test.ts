import { describe, expect, it } from "vitest";
import { runHeartbeat } from "./heartbeat";

describe("runHeartbeat", () => {
  it("beats at start and per interval, reports the db probe, and stops on signal", async () => {
    const lines: Array<{ message: string; extra?: Record<string, unknown> | undefined }> = [];
    let stop: () => void = () => {};
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const run = runHeartbeat({
      ping: async () => 1,
      intervalMs: 10,
      stopped,
      log: (message, extra) => lines.push({ message, extra }),
    });
    await new Promise((r) => setTimeout(r, 35));
    stop();
    const beats = await run;
    expect(beats).toBeGreaterThanOrEqual(2);
    expect(lines[0]).toEqual({ message: "worker heartbeat", extra: { beats: 1, db: "ok" } });
  });

  it("keeps beating when the database is unreachable", async () => {
    const lines: Array<Record<string, unknown> | undefined> = [];
    const beats = await runHeartbeat({
      ping: async () => Promise.reject(new Error("down")),
      stopped: new Promise((r) => setTimeout(r, 5)),
      intervalMs: 1_000,
      log: (_m, extra) => lines.push(extra),
    });
    expect(beats).toBe(1);
    expect(lines[0]?.db).toBe("unreachable");
  });
});
