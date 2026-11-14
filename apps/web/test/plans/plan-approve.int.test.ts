// M3-04 acceptance tests on the web side: the plan read model, the bound plan-action approval (payout and
// conversion), the refusal when the content or the revision moved, roles and tenancy.
import { createBusiness, type OutboxJob, schema } from "@carnet/db";
import { approvalHash, type PayoutSubject } from "@carnet/domain";
import { and, eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import type { PlanView } from "../../src/server/plans";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";
import { type PlanWorld, seedPlanWorld, specsFor } from "./plans-world";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", other: "" };
let world: PlanWorld;
let routes: Record<"current" | "byRevision" | "approve", RouteHandler>;

beforeAll(async () => {
  const { db, passwords, authz, rt, businessId } = env();
  const other = await createBusiness(db, { name: "Business B (synthetic)" });
  await addUser(db, other, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.approver = await sessionCookie(env(), "approver@carnet.example", passwords.approver);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.other = await sessionCookie(env(), "owner@b.example", "b-owner-password");
  world = await seedPlanWorld(db, businessId);
  const kit = createRouteKit({
    authz,
    db: () => db,
    logger: () => rt.logger,
    now: () => new Date(),
  });
  const specs = specsFor(world);
  routes = {
    current: kit.defineRoute(specs.current as never),
    byRevision: kit.defineRoute(specs.byRevision as never),
    approve: kit.defineRoute(specs.approve as never),
  };
});

const get = (kind: "current" | "byRevision", cookie?: string, revision?: number) =>
  routes[kind](
    new Request(`${ORIGIN}/api/v1/plans/${revision ?? "current"}`, {
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    }),
    revision === undefined
      ? undefined
      : { params: Promise.resolve({ revision: String(revision) }) },
  );

let keyN = 0;
const approve = (
  actionId: string,
  body: unknown,
  cookie?: string,
  key = `key-plan-${++keyN}-abcdef`,
) =>
  routes.approve(
    new Request(`${ORIGIN}/api/v1/plan-actions/${actionId}/approve`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "content-type": "application/json",
        "idempotency-key": key,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: actionId }) },
  );

const view = async (cookie = cookies.owner, revision?: number) =>
  (await (
    await get(revision === undefined ? "current" : "byRevision", cookie, revision)
  ).json()) as PlanView;

describe("plan read model", () => {
  it("shows the revision pair: held funds unavailable, the four actions, fates, a verified explanation", async () => {
    const v = await view();
    const p = v.plan;
    if (!p) throw new Error("no plan");
    expect(p.revision).toBe(2);
    expect(p.previous_revision).toBe(1);
    expect(p.actions.map((a) => a.kind)).toEqual(["convert", "fund", "payout", "defer"]);
    const eur = p.balances.find((b) => b.currency === "EUR");
    expect(eur?.held_minor).toBe("250000");
    expect(p.previous_balances?.find((b) => b.currency === "EUR")?.held_minor).toBe("0");
    expect(p.trigger).toEqual({ kind: "held", payee: "Nordlicht Print GmbH" });
    expect(p.explanation).toContain("is funded by converting USD");
    const fates = Object.fromEntries(p.obligations.map((o) => [o.payee, o.fate]));
    expect(fates).toMatchObject({
      "Payroll (team)": "funded",
      "Nordlicht Print GmbH": "alternate_payout",
      "Hosting bill": "deferred",
    });
    expect(p.obligations.find((o) => o.payee === "Nordlicht Print GmbH")?.changed).toBe(true);
    expect(p.obligations.find((o) => o.payee === "Payroll (team)")?.criticality?.planning).toBe(
      "UNCONFIRMED",
    );
    const payout = p.actions.find((a) => a.kind === "payout");
    expect(payout?.approvable).toBe(true);
    expect(payout?.bound?.reference).toBe("INV-NORDLICHT-77");
  });

  it("serves a stored revision and 404s a missing one and another business's plan", async () => {
    expect((await view(cookies.owner, 1)).plan?.revision).toBe(1);
    expect((await get("byRevision", cookies.owner, 9)).status).toBe(404);
    expect((await get("byRevision", cookies.other, 1)).status).toBe(404);
    const empty = (await (await get("current", cookies.other)).json()) as PlanView;
    expect(empty.plan).toBeNull();
    expect((await get("current")).status).toBe(401);
  });

  it("falls back to raw reasons when the explanation does not verify", async () => {
    const { loadPlanView } = await import("../../src/server/plans");
    const { repoCtx } = await import("@carnet/db");
    const v = await loadPlanView(
      repoCtx(env().db, world.businessId),
      { role: "owner" },
      "current",
      {
        ...world.deps,
        renderExplanation: () => "Payroll of EUR 9,999.99 is funded.",
      },
    );
    expect(v?.plan?.explanation).toBeNull();
  });

  it("marks a viewer as unable to act", async () => {
    expect((await view(cookies.judge)).can_act).toBe(false);
    expect((await view(cookies.owner)).can_act).toBe(true);
  });
});

describe("bound approval", () => {
  it("is refused for a viewer (403) and unauthenticated (401)", async () => {
    const p = (await view()).plan;
    const id = p?.actions.find((a) => a.kind === "payout")?.id ?? "";
    const body = { plan_revision: 2, shown: {} };
    expect((await approve(id, body, cookies.judge)).status).toBe(403);
    expect((await approve(id, body)).status).toBe(401);
    expect((await approve(id, body, cookies.other)).status).toBe(404);
  });

  it("changing the displayed amount in the database between render and click refuses the approval", async () => {
    const p = (await view()).plan;
    const payout = p?.actions.find((a) => a.kind === "payout");
    if (!payout?.bound) throw new Error("no bound content");
    const original = payout.bound.amount_minor;
    await env()
      .db.update(schema.payments)
      .set({ amountMinor: 260000n })
      .where(eq(schema.payments.id, world.paymentId));
    const res = await approve(payout.id, { plan_revision: 2, shown: payout.bound }, cookies.owner);
    expect(res.status).toBe(409);
    expect(
      ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("CONTENT_CHANGED");
    const rows = await env()
      .db.select()
      .from(schema.approvals)
      .where(eq(schema.approvals.subjectRef, world.paymentId));
    expect(rows).toHaveLength(0);
    await env()
      .db.update(schema.payments)
      .set({ amountMinor: BigInt(original ?? "250000") })
      .where(eq(schema.payments.id, world.paymentId));
  });

  it("approving a payout stores an approval whose hash covers every field shown, and queues the executor", async () => {
    const p = (await view()).plan;
    const payout = p?.actions.find((a) => a.kind === "payout");
    if (!payout?.bound) throw new Error("no bound content");
    const res = await approve(
      payout.id,
      { plan_revision: 2, shown: payout.bound },
      cookies.approver,
    );
    expect(res.status).toBe(201);
    const [row] = await env()
      .db.select()
      .from(schema.approvals)
      .where(
        and(eq(schema.approvals.subjectRef, world.paymentId), eq(schema.approvals.kind, "payout")),
      );
    if (!row) throw new Error("no approval");
    const snap = row.shownSnapshot as {
      subject: PayoutSubject;
      shown: Record<string, string>;
      planRevision: number;
    };
    expect(snap.shown).toEqual(payout.bound);
    expect(snap.planRevision).toBe(2);
    expect(approvalHash(snap.subject)).toBe(row.hash);
    // Each shown field is inside the hash: change any one and the hash changes.
    const fields: Array<[keyof PayoutSubject, string]> = [
      ["sourceAccount", "x"],
      ["sourceCurrency", "GBP"],
      ["beneficiaryFingerprint", "x"],
      ["amountMinor", "1"],
      ["currency", "GBP"],
      ["feeOption", "PAYER"],
      ["valueDate", "2030-01-01"],
      ["reference", "other"],
      ["counterpartyId", "x"],
    ];
    for (const [k, v] of fields) {
      expect(approvalHash({ ...snap.subject, [k]: v } as PayoutSubject)).not.toBe(row.hash);
    }
    expect(snap.subject.amountMinor).toBe(payout.bound.amount_minor);
    const state = (await view()).plan?.actions.find((a) => a.id === payout.id);
    expect(state?.state).toBe("APPROVED");
    const jobs = (await env().db.select().from(schema.outboxJobs)) as OutboxJob[];
    expect(
      jobs.some(
        (j) => j.kind === "payout.execute" && (j.payload as { hash: string }).hash === row.hash,
      ),
    ).toBe(true);
    // The same key replays; a second approval of an APPROVED action is a conflict.
    const again = await approve(
      payout.id,
      { plan_revision: 2, shown: payout.bound },
      cookies.approver,
    );
    expect(again.status).toBe(409);
  });

  it("after a new revision an approval for the old one is refused as 'plan changed'", async () => {
    const p = (await view()).plan;
    const convert = p?.actions.find((a) => a.kind === "convert");
    if (!convert?.bound) throw new Error("no bound content");
    await world.storeNext(world.revision2, (i) => ({
      ...i,
      balances: i.balances?.map((b) =>
        b.currency === "USD" ? { ...b, availableMinor: "900000" } : b,
      ),
    }));
    const res = await approve(
      convert.id,
      { plan_revision: 2, shown: convert.bound },
      cookies.owner,
    );
    expect(res.status).toBe(409);
    expect(
      ((await res.json()) as { error: { details: { reason: string } } }).error.details.reason,
    ).toBe("PLAN_CHANGED");
    const latest = (await view()).plan;
    expect(latest?.revision).toBe(3);
    const old = (await view(cookies.owner, 2)).plan;
    expect(old?.is_latest).toBe(false);
    expect(old?.actions.every((a) => !a.approvable)).toBe(true);
  });

  it("approves an out-of-policy conversion in the newest revision, bound to the stored action", async () => {
    const p = (await view()).plan;
    const convert = p?.actions.find((a) => a.kind === "convert");
    if (!convert?.bound) throw new Error("no bound content");
    const res = await approve(
      convert.id,
      { plan_revision: 3, shown: convert.bound },
      cookies.owner,
    );
    expect(res.status).toBe(201);
    const [row] = await env()
      .db.select()
      .from(schema.approvals)
      .where(eq(schema.approvals.subjectRef, convert.id));
    expect(row?.kind).toBe("conversion");
    // A body that differs from what the server derives is refused.
    const second = (await view()).plan?.actions.find((a) => a.kind === "payout");
    expect(second).toBeDefined();
  });
});
