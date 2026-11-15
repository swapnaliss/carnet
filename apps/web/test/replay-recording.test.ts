// M4-05: recordings are manifest-driven. The M2 recording's timeline is built from its recorded files
// only (each event names its source), and an M3-07 capture (scripts/demo-capture-m3.ts layout) dropped
// into a new directory is picked up without a code change.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadRecordings, ROOT } from "../../../scripts/replay/load";
import { recordingView, resolveScreen } from "../src/server/replay/recording";

describe("the M2 recording", () => {
  const m2 = loadRecordings().find((r) => r.id === "m2");

  it("is loaded from fixtures/replay/m2/manifest.json", () => {
    expect(m2?.manifest.kind).toBe("recording");
    expect(m2?.manifest.run_date).toBe("2026-11-12");
    expect(m2?.manifest.deployed_version).toBe("2331449c82f9");
  });

  it("has an ordered timeline with storyboard, webhook, model and respond events", () => {
    const events = m2?.timeline ?? [];
    expect(events.length).toBeGreaterThan(30);
    const times = events.map((e) => Date.parse(e.at));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    const kinds = new Set(events.map((e) => e.kind));
    for (const k of ["storyboard", "webhook", "model", "attempt", "approval"])
      expect(kinds).toContain(k);
    expect(events.some((e) => e.title === "Airwallex webhook payout.transfer.paid")).toBe(true);
    expect(
      events.some((e) => /Execution attempt: respond/.test(e.title) && /CONFIRMED/.test(e.detail)),
    ).toBe(true);
  });

  it("names a recorded file that exists as the source of every event", () => {
    for (const e of m2?.timeline ?? [])
      expect(existsSync(join(ROOT, e.source)), e.source).toBe(true);
  });

  it("links resolve only when the screens are loaded and the refs are known", () => {
    expect(resolveScreen("/rfis/{rfi}", { rfi: "abc" })).toBe("/rfis/abc");
    expect(resolveScreen("/rfis/{rfi}", {})).toBeNull();
    const view = recordingView({
      id: "m2",
      manifest: m2?.manifest,
      timeline: m2?.timeline,
      refs: { strong: "p1", weak: "p2", rfi: "r1" },
      materialized: false,
    });
    expect(view?.events.every((e) => e.href === null)).toBe(true);
  });
});

describe("a drop-in recording (M3-07 capture layout)", () => {
  it("is picked up from its manifest without code changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-"));
    const rec = join(dir, "m3");
    mkdirSync(rec);
    writeFileSync(
      join(rec, "manifest.json"),
      JSON.stringify({
        kind: "recording",
        label: "M3 run",
        run_date: "2026-11-16",
        files: ["webhooks.jsonl", "model-outputs.jsonl", "plans.json", "attempts.json"],
      }),
    );
    writeFileSync(
      join(rec, "webhooks.jsonl"),
      `${JSON.stringify({ name: "payout.transfer.paid", received_at: "2026-11-16T10:00:02Z", raw_body: JSON.stringify({ data: { id: "t1", status: "PAID" } }) })}\n`,
    );
    writeFileSync(
      join(rec, "model-outputs.jsonl"),
      `${JSON.stringify({ kind: "step", step: "criticality:x", model: "claude-sonnet-5-5", outcome: "ok", cost_nano_usd: 1000, created_at: "2026-11-16T10:00:00Z" })}\n`,
    );
    writeFileSync(
      join(rec, "plans.json"),
      JSON.stringify({
        plans: [{ revision: 2, status: "PROPOSED", created_at: "2026-11-16T10:00:01Z" }],
      }),
    );
    writeFileSync(
      join(rec, "attempts.json"),
      JSON.stringify({ execution_attempts: [], approvals: [], audit_log: [] }),
    );
    const [m3] = loadRecordings(dir);
    expect(m3?.id).toBe("m3");
    expect(m3?.timeline.map((e) => e.kind)).toEqual(["model", "plan", "webhook"]);
    expect(m3?.timeline[1]?.screen).toBe("/plans/current");
  });
});
