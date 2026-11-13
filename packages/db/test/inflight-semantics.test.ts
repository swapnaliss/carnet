// M4-02 against a real database: what the switches stop, what they let finish, the audited toggle and
// the spend figures. Runs where the app and migration role URLs are set (like the other database tests;
// it skips loudly otherwise). Reconciling an UNKNOWN / SENT_TO_AIRWALLEX attempt with both switches off
// is in apps/web/test/approval-killswitch.int.test.ts (the reconciler lives in the web workspace).
import { type ApprovalId, type BusinessId, newRequestId, type UserId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { ExecutionDisabledError } from "../src/errors";
import * as repos from "../src/repos/index";
import { useTestDatabase, withClient } from "./harness";

const hasDb = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
if (!hasDb)
  console.warn("inflight-semantics: DATABASE_URL/DATABASE_MIGRATION_URL not set; skipped");
const suite = hasDb ? describe : describe.skip;

const db = hasDb ? useTestDatabase({ prefix: "inflight" }) : () => never();
function never(): never {
  throw new Error("no database");
}

let biz: BusinessId;
let owner: UserId;
const ctx = () => repos.repoCtx(db().app.db, biz);
const HASH = "b".repeat(64);

async function setFlags(over: { agents?: boolean; execution?: boolean }): Promise<void> {
  await withClient(db().migrationUrl, async (c) => {
    if (over.agents !== undefined) {
      await c.query("UPDATE system_flags SET agents_enabled = $1 WHERE id = 1", [over.agents]);
    }
    if (over.execution !== undefined) {
      await c.query("UPDATE system_flags SET execution_enabled = $1 WHERE id = 1", [
        over.execution,
      ]);
    }
  });
}

const newApproval = () =>
  repos.createApproval(ctx(), {
    kind: "rfi_answer",
    subjectRef: crypto.randomUUID(),
    hash: HASH,
    nonce: crypto.randomUUID(),
    approverId: owner,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    shownSnapshot: { shown: true },
  });

beforeAll(async () => {
  if (!hasDb) return;
  biz = await repos.createBusiness(db().app.db, { name: "Inflight Co" });
  owner = (await repos.createUser(ctx(), { email: "owner@inflight.test", role: "owner" })).id;
});

suite("execution_enabled = false", () => {
  it("creates no ExecutionAttempt of any kind", async () => {
    await setFlags({ execution: false, agents: false });
    try {
      for (const kind of ["transfer", "conversion", "respond"] as const) {
        await expect(
          repos.createAttempt(ctx(), {
            kind,
            refId: crypto.randomUUID(),
            requestId: newRequestId(),
          }),
        ).rejects.toBeInstanceOf(ExecutionDisabledError);
      }
      expect(await repos.isExecutionEnabled(db().app.db)).toBe(false);
    } finally {
      await setFlags({ execution: true, agents: true });
    }
  });

  it("an attempt past INTENT still moves to resolution with both switches off", async () => {
    const attempt = await repos.createAttempt(ctx(), {
      kind: "transfer",
      refId: crypto.randomUUID(),
      requestId: newRequestId(),
    });
    await setFlags({ execution: false, agents: false });
    try {
      for (const status of ["SENT_TO_AIRWALLEX", "UNKNOWN", "CONFIRMED"] as const) {
        const next = await repos.updateAttemptStatus(ctx(), attempt.id, status);
        expect(next?.status).toBe(status);
      }
      expect((await repos.getAttempt(ctx(), attempt.id))?.resolvedAt).not.toBeNull();
    } finally {
      await setFlags({ execution: true, agents: true });
    }
  });

  it("an APPROVED approval is refused, ended as KILL_SWITCH and stays ended after re-enable; a fresh one works", async () => {
    const approval = await newApproval();
    await setFlags({ execution: false });
    const refused = await repos.consumeApproval(ctx(), {
      approvalId: approval.id as ApprovalId,
      expectedHash: HASH,
    });
    expect(refused).toEqual({ outcome: "refused", reason: "KILL_SWITCH" });
    const ended = await repos.getApproval(ctx(), approval.id as ApprovalId);
    expect(ended).toMatchObject({ status: "EXPIRED", endReason: "KILL_SWITCH" });

    await setFlags({ execution: true });
    const again = await repos.consumeApproval(ctx(), {
      approvalId: approval.id as ApprovalId,
      expectedHash: HASH,
    });
    expect(again).toEqual({ outcome: "refused", reason: "NOT_APPROVED" });

    const fresh = await newApproval();
    const ok = await repos.consumeApproval(ctx(), {
      approvalId: fresh.id as ApprovalId,
      expectedHash: HASH,
    });
    expect(ok.outcome).toBe("consumed");
  });

  it("the sweep query ends every live approval as KILL_SWITCH without deleting rows", async () => {
    const a = await newApproval();
    const refs = await repos.expireAllLiveApprovalsForKillSwitch(db().app.db);
    expect(refs.map((r) => r.id)).toContain(a.id);
    expect(await repos.getApproval(ctx(), a.id as ApprovalId)).toMatchObject({
      status: "EXPIRED",
      endReason: "KILL_SWITCH",
    });
  });
});

suite("the audited toggle", () => {
  it("changes the switch and writes one audit entry with actor, old and new value and reason", async () => {
    const before = (await repos.listAudit(ctx(), 500)).length;
    const result = await repos.setSwitch(ctx(), {
      flag: "execution_enabled",
      value: false,
      actorId: owner,
      reason: "drill",
    });
    expect(result).toMatchObject({ changed: true, before: true, after: false });
    expect((await repos.getSystemFlags(db().app.db)).executionEnabled).toBe(false);
    const entries = await repos.listAudit(ctx(), 500);
    expect(entries.length).toBe(before + 1);
    expect(entries[0]).toMatchObject({
      action: repos.FLAG_AUDIT_ACTION,
      subject: "execution_enabled",
      actorId: owner,
      data: { flag: "execution_enabled", old: true, new: false, reason: "drill" },
    });
    // Same value again: no change, no audit entry.
    const same = await repos.setSwitch(ctx(), {
      flag: "execution_enabled",
      value: false,
      actorId: owner,
    });
    expect(same.changed).toBe(false);
    expect((await repos.listAudit(ctx(), 500)).length).toBe(before + 1);
    expect((await repos.lastSwitchChanges(ctx())).execution_enabled).toMatchObject({
      actorId: owner,
      newValue: false,
      reason: "drill",
    });
    await repos.setSwitch(ctx(), { flag: "execution_enabled", value: true, actorId: owner });
  });
});

suite("spend figures", () => {
  it("match agent_runs.cost, and a new UTC day starts from zero", async () => {
    const run = await repos.createAgentRun(ctx(), { kind: "draft", ref: "spend" });
    for (const cost of [10_584_000, 2_000_000]) {
      await repos.recordAgentStep(ctx(), {
        runId: run.id,
        step: `s${cost}`,
        promptVersion: "v",
        model: "m",
        inputHash: "h",
        outcome: "ok",
        output: null,
        stopReason: "end_turn",
        inputTokens: 1,
        outputTokens: 1,
        costNanoUsd: cost,
        latencyMs: 1,
        providerRequestId: null,
      });
    }
    // A refusal before the network adds nothing.
    await repos.recordAgentStep(ctx(), {
      runId: run.id,
      step: "refused",
      promptVersion: "v",
      model: "m",
      inputHash: "h",
      outcome: "spend_cap",
      output: null,
      stopReason: null,
      inputTokens: 0,
      outputTokens: 0,
      costNanoUsd: 0,
      latencyMs: 0,
      providerRequestId: null,
    });
    const now = new Date();
    const summary = await repos.spendSummary(ctx(), now);
    const stored = await repos.getAgentRun(ctx(), run.id);
    expect(stored?.costNanoUsd).toBe(12_584_000);
    expect(summary.todayNanoUsd).toBe(stored?.costNanoUsd);
    expect(summary.largestRunTodayNanoUsd).toBe(12_584_000);
    // The same data seen from tomorrow (UTC): nothing counted yet.
    const tomorrow = new Date(now.getTime() + 24 * 3_600_000);
    expect((await repos.spendSummary(ctx(), tomorrow)).todayNanoUsd).toBe(0);
    // Refusals are not calls.
    expect(
      await repos.countAgentCalls(ctx(), { kind: "draft", ref: "spend", step: "refused" }),
    ).toBe(0);
  });
});
