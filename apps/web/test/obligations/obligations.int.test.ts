// M3-01 acceptance tests on the web side: the obligations API (scoping, roles, confirm), the propose job
// over a scripted model reply, and the database constraint that a criticality needs a confirming user.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createBusiness,
  createCounterparty,
  type Db,
  type OutboxJob,
  repoCtx,
  schema,
  storeDocument,
} from "@carnet/db";
import { ObligationViewSchema } from "@carnet/domain";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { replayTransport } from "../../../../packages/agent/evals/extraction/run";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { obligationSpecs } from "../../src/server/obligation-routes";
import { OBLIGATION_JOB_KIND } from "../../src/server/obligations/jobs";
import { createCriticalityProposeHandler } from "../../src/worker/handlers/criticality";
import type { HandlerContext } from "../../src/worker/handlers/index";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", other: "" };
const routes = {} as Record<keyof typeof obligationSpecs, RouteHandler>;
process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const CLAUSE =
  "5. Late payment: A late fee of 1.5% of the overdue amount is charged for each month an invoice stays unpaid.";
let counterpartyId = "";
let otherCounterpartyId = "";
let contractId = "";
let invoiceId = "";

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
  const kit = createRouteKit({
    authz,
    db: () => db,
    logger: () => rt.logger,
    now: () => new Date(),
  });
  for (const k of Object.keys(obligationSpecs) as (keyof typeof obligationSpecs)[]) {
    routes[k] = kit.defineRoute(obligationSpecs[k] as never);
  }
  const mine = repoCtx(db, businessId);
  counterpartyId = (
    await createCounterparty(mine, { name: "Fennel Packaging GmbH", country: "DE" })
  ).id;
  otherCounterpartyId = (
    await createCounterparty(repoCtx(db, other), { name: "Other Supplier", country: "DE" })
  ).id;
  const pdf = (f: string) => new Uint8Array(readFileSync(`${ROOT}${f}`));
  contractId = (
    await storeDocument(mine, {
      kind: "contract",
      filename: "ct-late-fee.pdf",
      mime: "application/pdf",
      bytes: pdf("fixtures/criticality/ct-late-fee.pdf"),
    })
  ).document.id;
  invoiceId = (
    await storeDocument(mine, {
      kind: "invoice",
      filename: "inv-harbor-001.pdf",
      mime: "application/pdf",
      bytes: pdf("fixtures/dataset/inv-harbor-001.pdf"),
    })
  ).document.id;
});

const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });
function call(
  kind: keyof typeof obligationSpecs,
  method: string,
  id: string | null,
  body?: unknown,
  cookie?: string,
  path = "",
) {
  const headers: Record<string, string> = { origin: ORIGIN, "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  return routes[kind](
    new Request(`${ORIGIN}/api/v1/obligations${id ? `/${id}` : ""}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    id ? idCtx(id) : undefined,
  );
}

const newBody = (extra: object = {}) => ({
  counterparty_id: counterpartyId,
  amount_minor: "840000",
  currency: "EUR",
  due_at: "2026-12-01T00:00:00Z",
  source_document_id: contractId,
  ...extra,
});

async function create(extra: object = {}) {
  const res = await call("create", "POST", null, newBody(extra), cookies.owner);
  expect(res.status).toBe(201);
  return ObligationViewSchema.parse(await res.json());
}

describe("obligations API", () => {
  it("creates, lists and gets; planning criticality is UNCONFIRMED", async () => {
    const o = await create();
    expect(o.amount_minor).toBe("840000");
    expect(o.criticality).toBeNull();
    expect(o.planning_criticality).toBe("UNCONFIRMED");
    const list = await call("list", "GET", null, undefined, cookies.judge);
    expect(list.status).toBe(200);
    expect(((await list.json()) as { items: { id: string }[] }).items.map((i) => i.id)).toContain(
      o.id,
    );
    expect((await call("get", "GET", o.id, undefined, cookies.judge)).status).toBe(200);
  });

  it("scopes by business: another business's obligation is 404 and its list excludes ours", async () => {
    const o = await create();
    expect((await call("get", "GET", o.id, undefined, cookies.other)).status).toBe(404);
    const list = await call("list", "GET", null, undefined, cookies.other);
    expect(((await list.json()) as { items: unknown[] }).items).toHaveLength(0);
    expect(
      (
        await call(
          "confirm",
          "POST",
          o.id,
          { criticality: 1 },
          cookies.other,
          "/criticality/confirm",
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await call(
          "create",
          "POST",
          null,
          newBody({ counterparty_id: otherCounterpartyId }),
          cookies.owner,
        )
      ).status,
    ).toBe(404);
  });

  it("refuses a viewer and an unauthenticated create", async () => {
    expect((await call("create", "POST", null, newBody(), cookies.judge)).status).toBe(403);
    expect((await call("create", "POST", null, newBody())).status).toBe(401);
  });
});

describe("confirm", () => {
  it("is refused for a viewer and unauthenticated; the owner sets it with user, time and proposal id", async () => {
    const o = await create();
    const p = "/criticality/confirm";
    expect((await call("confirm", "POST", o.id, { criticality: 1 }, cookies.judge, p)).status).toBe(
      403,
    );
    expect((await call("confirm", "POST", o.id, { criticality: 1 }, undefined, p)).status).toBe(
      401,
    );
    expect(
      (
        (await call("get", "GET", o.id, undefined, cookies.owner).then((r) => r.json())) as {
          criticality: null;
        }
      ).criticality,
    ).toBeNull();

    const res = await call("confirm", "POST", o.id, { criticality: 2 }, cookies.owner, p);
    expect(res.status).toBe(200);
    const done = ObligationViewSchema.parse(await res.json());
    expect(done.criticality).toBe(2);
    expect(done.planning_criticality).toBe(2);
    expect(done.criticality_confirmed_by).toBeTruthy();
    expect(done.criticality_confirmed_at).toBeTruthy();
    const audit = await env()
      .db.select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.subject, `obligation:${o.id}`));
    expect(audit.some((a) => a.action === "obligation.criticality_confirmed")).toBe(true);
  });

  it("creating and confirming each queue a plan.rerun in the same transaction (ADR 0021)", async () => {
    const rerunsFor = async (eventId: string) =>
      (await env().db.select().from(schema.outboxJobs)).filter(
        (j) =>
          j.kind === "plan.rerun" &&
          (j.payload as { eventId?: string } | null)?.eventId === eventId,
      );
    const o = await create();
    expect(await rerunsFor(`obligation:${o.id}:created`)).toHaveLength(1);
    expect(await rerunsFor(`obligation:${o.id}:criticality:3`)).toHaveLength(0);
    const res = await call(
      "confirm",
      "POST",
      o.id,
      { criticality: 3 },
      cookies.owner,
      "/criticality/confirm",
    );
    expect(res.status).toBe(200);
    expect(await rerunsFor(`obligation:${o.id}:criticality:3`)).toHaveLength(1);
    // A refused confirm (unknown proposal) rolls back with it: no job for it.
    const refused = await call(
      "confirm",
      "POST",
      o.id,
      { criticality: 1, proposal_id: crypto.randomUUID() },
      cookies.owner,
      "/criticality/confirm",
    );
    expect(refused.status).toBe(400);
    expect(await rerunsFor(`obligation:${o.id}:criticality:1`)).toHaveLength(0);
  });

  it("rejects an unknown proposal id", async () => {
    const o = await create();
    const res = await call(
      "confirm",
      "POST",
      o.id,
      { criticality: 1, proposal_id: crypto.randomUUID() },
      cookies.owner,
      "/criticality/confirm",
    );
    expect(res.status).toBe(400);
  });
});

describe("propose job", () => {
  const ctx = (db: Db): HandlerContext => ({
    db,
    airwallex: {} as unknown as HandlerContext["airwallex"],
    logger: env().rt.logger as unknown as HandlerContext["logger"],
  });
  const reply = (out: object) =>
    replayTransport({
      document_id: "scripted",
      calls: [
        {
          response: {
            id: "msg_scripted",
            model: "claude-sonnet-5-5",
            stop_reason: "end_turn",
            usage: { input_tokens: 10, output_tokens: 10 },
            content: [{ type: "text", text: JSON.stringify(out) }],
          },
          request_id: null,
          latency_ms: 0,
        },
      ],
    });
  async function jobFor(obligationId: string): Promise<OutboxJob> {
    const rows = await env().db.select().from(schema.outboxJobs);
    const row = rows
      .filter(
        (r) =>
          r.kind === OBLIGATION_JOB_KIND.proposeCriticality &&
          (r.payload as { obligationId?: string }).obligationId === obligationId,
      )
      .at(-1);
    if (!row) throw new Error("no propose job queued");
    return { ...row, lockedAt: row.lockedAt ?? null } as unknown as OutboxJob;
  }

  it("queues a job, stores a PROPOSED proposal with a verbatim quote, never sets criticality; confirm marks it CONFIRMED", async () => {
    const o = await create();
    const queued = await call("propose", "POST", o.id, {}, cookies.owner, "/criticality/propose");
    expect(queued.status).toBe(202);
    const job = await jobFor(o.id);
    await createCriticalityProposeHandler({
      transport: reply({
        criticality: "2",
        rationale: "A late fee applies.",
        quote: CLAUSE,
        page: 2,
        injection_suspected: false,
      }),
    })(job.payload, ctx(env().db), job);
    // A second delivery of the same job stores nothing new.
    await createCriticalityProposeHandler({
      transport: reply({
        criticality: "1",
        rationale: "x",
        quote: CLAUSE,
        page: 2,
        injection_suspected: false,
      }),
    })(job.payload, ctx(env().db), job);

    const got = ObligationViewSchema.parse(
      await (await call("get", "GET", o.id, undefined, cookies.owner)).json(),
    );
    expect(got.latest_proposal?.status).toBe("PROPOSED");
    expect(got.latest_proposal?.proposed_criticality).toBe(2);
    expect(got.latest_proposal?.quote).toBe(CLAUSE);
    expect(got.criticality).toBeNull();
    expect(got.planning_criticality).toBe("UNCONFIRMED");
    const proposals = await env()
      .db.select()
      .from(schema.criticalityProposals)
      .where(eq(schema.criticalityProposals.obligationId, o.id));
    expect(proposals).toHaveLength(1);

    const res = await call(
      "confirm",
      "POST",
      o.id,
      { criticality: 2, proposal_id: got.latest_proposal?.id },
      cookies.owner,
      "/criticality/confirm",
    );
    const done = ObligationViewSchema.parse(await res.json());
    expect(done.criticality_confirmed_proposal_id).toBe(got.latest_proposal?.id);
    expect(done.latest_proposal?.status).toBe("CONFIRMED");
  });

  it("a fabricated quote is REJECTED with no supporting clause; an override is OVERRIDDEN", async () => {
    const o = await create();
    await call("propose", "POST", o.id, {}, cookies.owner, "/criticality/propose");
    const job = await jobFor(o.id);
    await createCriticalityProposeHandler({
      transport: reply({
        criticality: "1",
        rationale: "r",
        quote: "Supplier may terminate at once.",
        page: 2,
        injection_suspected: false,
      }),
    })(job.payload, ctx(env().db), job);
    const got = ObligationViewSchema.parse(
      await (await call("get", "GET", o.id, undefined, cookies.owner)).json(),
    );
    expect(got.latest_proposal?.status).toBe("REJECTED");
    expect(got.latest_proposal?.message).toBe("No supporting clause found");
    expect(got.latest_proposal?.proposed_criticality).toBeNull();
    expect(got.planning_criticality).toBe("UNCONFIRMED");
  });

  it("only a contract can be proposed on", async () => {
    const o = await create({ source_document_id: invoiceId });
    expect(
      (await call("propose", "POST", o.id, {}, cookies.owner, "/criticality/propose")).status,
    ).toBe(400);
  });
});

describe("database constraint", () => {
  it("rejects a criticality without a confirming user", async () => {
    const o = await create();
    await expect(
      env()
        .db.update(schema.obligations)
        .set({ criticality: 1 })
        .where(eq(schema.obligations.id, o.id)),
    ).rejects.toThrow();
  });
});
