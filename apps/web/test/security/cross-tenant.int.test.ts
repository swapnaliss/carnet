// Cross-tenant access (M1-10 AC 7). Two parts:
// 1. Inventory: every API route with a path id (a dynamic segment other than a catch-all) must have a
//    case in CROSS_TENANT_CASES, so a new id route (M1-08 payments onward) cannot land without one. At
//    this commit no such route exists, so the table is empty and the inventory says so.
// 2. The pattern every such route uses, proven end to end: `defineRoute` + `params` + `repo`, with real
//    sessions and real tenant repositories. Business A's session gets 404 for business B's id; the
//    viewer (judge) gets 403 on the mutation.
import {
  createBusiness,
  createPayment,
  getPayment,
  repoCtx,
  updatePaymentTransfer,
} from "@carnet/db";
import { ApiErrorSchema, money, type PaymentId, PaymentIdSchema } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { notFound } from "../../src/lib/errors";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";
import { apiRoutes } from "./api-routes";

/** route (relative to src/app/api) → how its test proves 404 cross-tenant and 403 for the viewer. */
export const CROSS_TENANT_CASES: Record<string, string> = {
  // M2-04: test/security/rfi-ingest-routes.int.test.ts (404 cross-tenant, viewer 403, audited link).
  "v1/rfis/[id]": "rfi-ingest-routes.int.test.ts",
  "v1/rfis/[id]/link": "rfi-ingest-routes.int.test.ts",
  "v1/documents/[id]":
    "test/documents/documents.int.test.ts: another business's session gets 404 for the bytes",
  "v1/documents/[id]/meta":
    "test/documents/documents.int.test.ts: another business's session gets 404 for the metadata",
  "v1/documents/[id]/facts":
    "test/documents/facts.int.test.ts: another business's session gets 404 for the facts",
  "v1/documents/[id]/facts/[version]/confirm":
    "test/documents/facts.int.test.ts: another business's owner gets 404 and no version is written; viewer 403",
  "v1/payments/[id]":
    "test/payments/api.int.test.ts 'cross-tenant': another business's id is 404 with no data, both ways",
  "v1/payments/[id]/simulate":
    "test/payments/api.int.test.ts 'cross-tenant': foreign id 404 and no job queued; viewer 403",
};

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", otherOwner: "" };
let ownPayment: PaymentId;
let foreignPayment: PaymentId;
let getRoute: RouteHandler;
let patchRoute: RouteHandler;

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  const params = z.strictObject({ id: PaymentIdSchema });
  getRoute = kit.defineRoute({
    method: "GET",
    auth: "session",
    params,
    handler: async ({ repo, params: { id } }) => {
      const payment = await getPayment(repo, id);
      if (!payment) throw notFound();
      return Response.json({ id: payment.id, reference: payment.reference });
    },
  });
  patchRoute = kit.defineRoute({
    method: "PATCH",
    auth: { roles: ["owner", "approver"] },
    params,
    body: z.strictObject({ transferId: z.string().min(1).max(64) }),
    handler: async ({ repo, params: { id }, body }) => {
      const payment = await getPayment(repo, id);
      if (!payment) throw notFound();
      await updatePaymentTransfer(repo, id, {
        transferId: body.transferId,
        transferStatus: "PROCESSING",
        transferUpdatedAt: new Date(),
      });
      return Response.json({ id });
    },
  });

  const mk = (b: typeof businessId) =>
    createPayment(repoCtx(db, b), {
      amount: money(1000n, "USD"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: "cross-tenant",
    });
  ownPayment = (await mk(businessId)).id;
  const other = await createBusiness(db, { name: "Business B (synthetic)" });
  foreignPayment = (await mk(other)).id;
  await addUser(db, other, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });

  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.approver = await sessionCookie(env(), "approver@carnet.example", passwords.approver);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.otherOwner = await sessionCookie(env(), "owner@b.example", "b-owner-password");
});

function call(route: RouteHandler, method: string, id: string, cookie: string, body?: unknown) {
  return route(
    new Request(`${ORIGIN}/api/v1/payments/${id}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("inventory: every id-taking API route has a cross-tenant case", () => {
  it("lists the id routes and requires a case for each", () => {
    const idRoutes = apiRoutes().filter((r) => /\[(?!\.\.\.)[^\]]+\]/.test(r));
    for (const route of idRoutes) expect(CROSS_TENANT_CASES, route).toHaveProperty(route);
    // auth/[...all] is a catch-all, not a resource id; M2-01 adds the documents routes.
    expect([...idRoutes].sort()).toEqual(Object.keys(CROSS_TENANT_CASES).sort());
  });
});

describe("defineRoute + repo(ctx): tenancy and roles", () => {
  it("reads: own id 200; another business's id 404 (never 403, never data)", async () => {
    expect((await call(getRoute, "GET", ownPayment, cookies.owner)).status).toBe(200);
    const res = await call(getRoute, "GET", foreignPayment, cookies.owner);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(ApiErrorSchema.parse(JSON.parse(text)).error.code).toBe("NOT_FOUND");
    expect(text).not.toContain("cross-tenant");
    // And the other way round.
    expect((await call(getRoute, "GET", ownPayment, cookies.otherOwner)).status).toBe(404);
    expect((await call(getRoute, "GET", foreignPayment, cookies.otherOwner)).status).toBe(200);
  });

  it("mutations: another business's id 404 and unchanged; viewer 403; owner and approver 200", async () => {
    const res = await call(patchRoute, "PATCH", foreignPayment, cookies.owner, {
      transferId: "t-x",
    });
    expect(res.status).toBe(404);
    const other = await getPayment(
      repoCtx(env().db, (await sessionBusiness(cookies.otherOwner)) ?? env().businessId),
      foreignPayment,
    );
    expect(other?.transferId ?? null).toBeNull();

    const viewer = await call(patchRoute, "PATCH", ownPayment, cookies.judge, {
      transferId: "t-v",
    });
    expect(viewer.status).toBe(403);
    expect(ApiErrorSchema.parse(await viewer.json()).error.code).toBe("FORBIDDEN");
    // The viewer still reads.
    expect((await call(getRoute, "GET", ownPayment, cookies.judge)).status).toBe(200);

    expect(
      (await call(patchRoute, "PATCH", ownPayment, cookies.approver, { transferId: "t-a" })).status,
    ).toBe(200);
    expect(
      (await call(patchRoute, "PATCH", ownPayment, cookies.owner, { transferId: "t-o" })).status,
    ).toBe(200);
  });

  it("a malformed id is 400 before any lookup; no session is 401", async () => {
    expect((await call(getRoute, "GET", "not-a-uuid", cookies.owner)).status).toBe(400);
    expect((await call(getRoute, "GET", ownPayment, "")).status).toBe(401);
  });
});

async function sessionBusiness(cookie: string) {
  const session = await env().rt.auth.api.getSession({ headers: new Headers({ cookie }) });
  return (session?.user as { businessId?: string } | undefined)?.businessId as
    | Parameters<typeof repoCtx>[1]
    | undefined;
}
