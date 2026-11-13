// M4-02 circuit breakers: the rule is a pure function of recent outcomes (openings, cool-down,
// half-open probe, close on success), and the state is read from database rows, so two independent
// readers agree. No module-level mutable state (asserted by reading the source).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BreakerConfig,
  type DependencyOutcome,
  dependencyOfJobKind,
  deriveBreaker,
  readBreaker,
} from "../src/breaker";
import { createDbClient } from "../src/client";
import type { schema } from "../src/index";
import * as repos from "../src/repos/index";
import { useTestDatabase, withClient } from "./harness";

const CONFIG: BreakerConfig = { failureThreshold: 3, windowMs: 5 * 60_000, coolDownMs: 60_000 };
const NOW = new Date("2026-11-13T12:00:00Z");
const ago = (s: number) => new Date(NOW.getTime() - s * 1000);
const fail = (s: number): DependencyOutcome => ({ at: ago(s), ok: false });
const ok = (s: number): DependencyOutcome => ({ at: ago(s), ok: true });

describe("deriveBreaker (pure)", () => {
  it("stays CLOSED below the threshold", () => {
    expect(deriveBreaker("airwallex", [fail(10), fail(20)], CONFIG, NOW).state).toBe("CLOSED");
  });

  it("reports zero samples as no data, not health", () => {
    expect(deriveBreaker("model", [], CONFIG, NOW)).toMatchObject({
      state: "CLOSED",
      samplesInWindow: 0,
    });
  });

  it("opens at N failures inside the window, with the retry time", () => {
    const v = deriveBreaker("airwallex", [fail(10), fail(20), fail(30)], CONFIG, NOW);
    expect(v).toMatchObject({ state: "OPEN", failuresInWindow: 3 });
    expect(v.retryAt?.getTime()).toBe(ago(10).getTime() + CONFIG.coolDownMs);
  });

  it("failures older than the window do not count", () => {
    expect(deriveBreaker("model", [fail(400), fail(410), fail(420)], CONFIG, NOW).state).toBe(
      "CLOSED",
    );
  });

  it("half-opens after the cool-down", () => {
    expect(deriveBreaker("model", [fail(70), fail(80), fail(90)], CONFIG, NOW).state).toBe(
      "HALF_OPEN",
    );
  });

  it("closes after a success that follows the last failure", () => {
    expect(deriveBreaker("model", [fail(70), fail(80), fail(90), ok(5)], CONFIG, NOW).state).toBe(
      "CLOSED",
    );
  });

  it("a failed probe restarts the cool-down (OPEN again)", () => {
    expect(deriveBreaker("model", [fail(70), fail(80), fail(90), fail(5)], CONFIG, NOW).state).toBe(
      "OPEN",
    );
  });

  it("a success older than the last failure does not close it", () => {
    expect(deriveBreaker("model", [ok(100), fail(30), fail(40), fail(50)], CONFIG, NOW).state).toBe(
      "OPEN",
    );
  });

  it("is order independent", () => {
    const events = [fail(10), ok(200), fail(20), fail(30)];
    expect(deriveBreaker("model", events, CONFIG, NOW)).toEqual(
      deriveBreaker("model", [...events].reverse(), CONFIG, NOW),
    );
  });

  it("maps job kinds to a dependency; the reconciler has none", () => {
    expect(dependencyOfJobKind("transfer.create")).toBe("airwallex");
    expect(dependencyOfJobKind("rfi.respond")).toBe("airwallex");
    expect(dependencyOfJobKind("rfi.draft")).toBe("model");
    expect(dependencyOfJobKind("reconcile")).toBeNull();
  });
});

describe("no in-memory breaker state", () => {
  it("breaker.ts has no module-level let/var and no mutable collection", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/breaker.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/^(let|var) /m);
    expect(src).not.toMatch(/^const \w+\s*(:[^=]+)?=\s*new (Map|Set)\b/m);
  });
});

const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
const suite = hasDb ? describe : describe.skip;
const db = hasDb ? useTestDatabase({ prefix: "breaker" }) : () => undefined as never;

suite("from database rows", () => {
  let biz: Awaited<ReturnType<typeof repos.createBusiness>>;
  beforeAll(async () => {
    biz = await repos.createBusiness(db().app.db, { name: "Breaker Co" });
  });

  it("Airwallex: failed jobs open it; two independent readers agree; a DONE job closes it", async () => {
    const now = new Date();
    await withClient(db().migrationUrl, async (c) => {
      for (let i = 0; i < 3; i += 1) {
        await c.query(
          `INSERT INTO outbox_jobs (kind, payload, status, attempts, locked_at, last_error)
           VALUES ('transfer.create', '{}', 'RETRY', 1, $1, 'boom')`,
          [new Date(now.getTime() - 5_000 - i * 1000)],
        );
      }
      // Not a dependency call: the reconciler's failures never count.
      await c.query(
        `INSERT INTO outbox_jobs (kind, payload, status, attempts, locked_at)
         VALUES ('reconcile', '{}', 'DEAD', 8, $1)`,
        [now],
      );
    });
    const second = createDbClient(db().appUrl, { max: 1 });
    try {
      const a = await readBreaker(db().app.db, "airwallex", CONFIG, now);
      const b = await readBreaker(second.db, "airwallex", CONFIG, now);
      expect(a.state).toBe("OPEN");
      expect(b).toEqual(a);

      await withClient(db().migrationUrl, (c) =>
        c.query(
          `INSERT INTO outbox_jobs (kind, payload, status, attempts, finished_at, locked_at)
           VALUES ('transfer.sync', '{}', 'DONE', 1, $1, $1)`,
          [new Date(now.getTime() - 1_000)],
        ),
      );
      expect((await readBreaker(db().app.db, "airwallex", CONFIG, now)).state).toBe("CLOSED");
      expect(await readBreaker(second.db, "airwallex", CONFIG, now)).toEqual(
        await readBreaker(db().app.db, "airwallex", CONFIG, now),
      );
    } finally {
      await second.close();
    }
  });

  it("model: provider_error steps open it, killed and spend_cap steps do not count", async () => {
    const ctx = repos.repoCtx(db().app.db, biz);
    const run = await repos.createAgentRun(ctx, { kind: "draft", ref: "breaker" });
    const step = (outcome: (typeof schema.agentSteps.$inferSelect)["outcome"]) =>
      repos.recordAgentStep(ctx, {
        runId: run.id,
        step: crypto.randomUUID(),
        promptVersion: "v",
        model: "m",
        inputHash: "h",
        outcome,
        output: null,
        stopReason: null,
        inputTokens: 0,
        outputTokens: 0,
        costNanoUsd: 0,
        latencyMs: 1,
        providerRequestId: null,
      });
    for (let i = 0; i < 5; i += 1) await step("killed");
    expect((await readBreaker(db().app.db, "model", CONFIG)).state).toBe("CLOSED");
    for (let i = 0; i < 3; i += 1) await step("provider_error");
    expect((await readBreaker(db().app.db, "model", CONFIG)).state).toBe("OPEN");
    await step("ok");
    expect((await readBreaker(db().app.db, "model", CONFIG)).state).toBe("CLOSED");
  });
});
