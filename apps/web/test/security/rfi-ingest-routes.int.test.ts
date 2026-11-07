// M2-04 AC 10: another business's RFIs are never returned, matched or linked. The exact production route
// specs (src/server/rfi-routes.ts) run on a kit built over real sessions and tenant repositories. Also
// the owner-link endpoint: audited, viewer 403, foreign payment or RFI 404.
import {
  appendAudit,
  createBusiness,
  createPayment,
  insertRfi,
  insertRfiQuestions,
  listAudit,
  repoCtx,
} from "@carnet/db";
import { type BusinessId, money, type PaymentId, type RfiId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { rfiGetSpec, rfiLinkSpec, rfiListSpec } from "../../src/server/rfi-routes";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const cookies = { owner: "", judge: "", otherOwner: "" };
let bizA: BusinessId;
let bizB: BusinessId;
let rfiA: RfiId;
let rfiB: RfiId;
let payA: PaymentId;
let payB: PaymentId;
let list: RouteHandler;
let get: RouteHandler;
let link: RouteHandler;

const newRfi = (id: string, paymentId: PaymentId | null) => ({
  airwallexRfiId: id,
  type: "TRANSACTION",
  subType: null,
  airwallexStatus: "ACTION_REQUIRED" as const,
  airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
  airwallexAnsweredRequests: 0,
  state: "DRAFTING" as const,
  round: 1,
  expiresAt: null,
  paymentId,
  orphanReason: paymentId ? null : ("NO_SOURCES" as const),
  linkedBy: paymentId ? ("match" as const) : null,
  sourceKey: null,
  conflict: false,
});

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  list = kit.defineRoute(rfiListSpec);
  get = kit.defineRoute(rfiGetSpec);
  link = kit.defineRoute(rfiLinkSpec);

  bizA = businessId;
  bizB = await createBusiness(db, { name: "Business B (synthetic)" });
  const pay = async (b: BusinessId) =>
    (
      await createPayment(repoCtx(db, b), {
        amount: money(1000n, "USD"),
        sourceCurrency: "USD",
        method: "LOCAL",
        reference: "rfi-routes",
      })
    ).id;
  payA = await pay(bizA);
  payB = await pay(bizB);
  rfiA = (await insertRfi(repoCtx(db, bizA), newRfi("rfi-a-orphan", null))).id;
  rfiB = (await insertRfi(repoCtx(db, bizB), newRfi("rfi-b-linked", payB))).id;
  await insertRfiQuestions(repoCtx(db, bizB), rfiB, [
    {
      round: 1,
      airwallexQuestionId: "q-b",
      position: 0,
      title: { en: "B secret question", zh: null },
      description: { en: "B", zh: null },
      comment: null,
      answerType: "TEXT",
      sources: [],
      reopened: false,
      needsDrafting: true,
    },
  ]);
  await addUser(db, bizB, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.otherOwner = await sessionCookie(env(), "owner@b.example", "b-owner-password");
});

function call(
  route: RouteHandler,
  method: string,
  path: string,
  cookie: string,
  params?: Record<string, string>,
  body?: unknown,
) {
  return route(
    new Request(`${ORIGIN}/api/v1/rfis${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params ?? {}) },
  );
}

describe("reads are scoped to the session's business", () => {
  it("the list returns only own RFIs, and the orphan queue only own orphans", async () => {
    const own = (await (await call(list, "GET", "", cookies.owner)).json()) as {
      items: { id: string; payment_id: string | null }[];
    };
    expect(own.items.map((i) => i.id)).toEqual([rfiA]);
    const orphans = (await (await call(list, "GET", "?orphan=true", cookies.owner)).json()) as {
      items: { id: string }[];
    };
    expect(orphans.items.map((i) => i.id)).toEqual([rfiA]);
    const other = (await (await call(list, "GET", "", cookies.otherOwner)).json()) as {
      items: { id: string }[];
    };
    expect(other.items.map((i) => i.id)).toEqual([rfiB]);
    const otherOrphans = (await (
      await call(list, "GET", "?orphan=true", cookies.otherOwner)
    ).json()) as { items: unknown[] };
    expect(otherOrphans.items).toEqual([]);
  });

  it("GET by id: own 200 with questions; another business's id 404 without any of its data", async () => {
    expect((await call(get, "GET", `/${rfiA}`, cookies.owner, { id: rfiA })).status).toBe(200);
    const res = await call(get, "GET", `/${rfiB}`, cookies.owner, { id: rfiB });
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("B secret question");
    const own = (await (
      await call(get, "GET", `/${rfiB}`, cookies.otherOwner, { id: rfiB })
    ).json()) as { questions: { title: { en: string } }[] };
    expect(own.questions[0]?.title.en).toBe("B secret question");
  });
});

describe("POST /rfis/{id}/link", () => {
  it("links an orphan to an own payment, audits it, and removes the link on null", async () => {
    const res = await call(
      link,
      "POST",
      `/${rfiA}/link`,
      cookies.owner,
      { id: rfiA },
      { payment_id: payA },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: rfiA,
      payment_id: payA,
      orphan_reason: null,
      linked_by: "owner",
    });
    const audit = await listAudit(repoCtx(env().db, bizA));
    expect(
      audit.find((a) => a.action === "rfi.linked" && a.subject === `rfi:${rfiA}`)?.data,
    ).toMatchObject({ by: "owner", paymentId: payA });

    const off = await call(
      link,
      "POST",
      `/${rfiA}/link`,
      cookies.owner,
      { id: rfiA },
      { payment_id: null },
    );
    expect(await off.json()).toMatchObject({ payment_id: null, orphan_reason: "OWNER_UNLINKED" });
    expect(
      (await listAudit(repoCtx(env().db, bizA))).some((a) => a.action === "rfi.unlinked"),
    ).toBe(true);
  });

  it("cannot link another business's RFI, nor an own RFI to another business's payment (404, unchanged)", async () => {
    const foreignRfi = await call(
      link,
      "POST",
      `/${rfiB}/link`,
      cookies.owner,
      { id: rfiB },
      { payment_id: payA },
    );
    expect(foreignRfi.status).toBe(404);
    const foreignPayment = await call(
      link,
      "POST",
      `/${rfiA}/link`,
      cookies.owner,
      { id: rfiA },
      { payment_id: payB },
    );
    expect(foreignPayment.status).toBe(404);
    const b = (await (
      await call(get, "GET", `/${rfiB}`, cookies.otherOwner, { id: rfiB })
    ).json()) as { payment_id: string };
    expect(b.payment_id).toBe(payB);
    const a = (await (await call(get, "GET", `/${rfiA}`, cookies.owner, { id: rfiA })).json()) as {
      orphan_reason: string;
    };
    expect(a.orphan_reason).toBe("OWNER_UNLINKED");
  });

  it("the read-only viewer is refused (403); a malformed id or body is 400", async () => {
    expect(
      (await call(link, "POST", `/${rfiA}/link`, cookies.judge, { id: rfiA }, { payment_id: payA }))
        .status,
    ).toBe(403);
    expect(
      (
        await call(
          link,
          "POST",
          "/x/link",
          cookies.owner,
          { id: "not-a-uuid" },
          { payment_id: payA },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          link,
          "POST",
          `/${rfiA}/link`,
          cookies.owner,
          { id: rfiA },
          { payment_id: payA, extra: 1 },
        )
      ).status,
    ).toBe(400);
  });
});

describe("sanity", () => {
  it("appendAudit stays tenant-scoped (the fixture business has its own entries)", async () => {
    await appendAudit(repoCtx(env().db, bizB), { actorType: "system", action: "x", subject: "y" });
    expect((await listAudit(repoCtx(env().db, bizA))).every((a) => a.businessId === bizA)).toBe(
      true,
    );
  });
});
