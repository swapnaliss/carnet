// M2-08: the hold screen's read model and the owner-edit route are tenant-scoped. Another business's RFI
// is 404 without any of its data, the viewer (judge) is 403 on the edit, and the list route carries the
// payment summary only for own payments. Exact production specs (src/server/hold.ts, rfi-routes.ts).
import {
  createBusiness,
  createCounterparty,
  createPayment,
  insertRfi,
  insertRfiQuestions,
  repoCtx,
} from "@carnet/db";
import { type BusinessId, money, type PaymentId, type RfiId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { holdViewSpec, ownerDraftSpec } from "../../src/server/hold";
import { rfiListSpec } from "../../src/server/rfi-routes";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";

const env = setupAuthTestEnv();
const cookies = { owner: "", judge: "", otherOwner: "" };
let rfiA: RfiId;
let rfiB: RfiId;
let hold: RouteHandler;
let drafts: RouteHandler;
let list: RouteHandler;

const newRfi = (id: string, paymentId: PaymentId) => ({
  airwallexRfiId: id,
  type: "TRANSACTION",
  subType: null,
  airwallexStatus: "ACTION_REQUIRED" as const,
  airwallexUpdatedAt: new Date("2026-11-03T09:57:38Z"),
  airwallexAnsweredRequests: 0,
  state: "DRAFT_READY" as const,
  round: 1,
  expiresAt: null,
  paymentId,
  orphanReason: null,
  linkedBy: "match" as const,
  sourceKey: null,
  conflict: false,
});

async function seed(b: BusinessId, awId: string, name: string) {
  const rc = repoCtx(env().db, b);
  const cp = await createCounterparty(rc, { name, country: "DE" });
  const pay = await createPayment(rc, {
    counterpartyId: cp.id,
    amount: money(1000n, "EUR"),
    sourceCurrency: "USD",
    method: "SWIFT",
    reference: `ref-${awId}`,
  });
  const rfi = await insertRfi(rc, newRfi(awId, pay.id));
  await insertRfiQuestions(rc, rfi.id, [
    {
      round: 1,
      airwallexQuestionId: `q-${awId}`,
      position: 0,
      title: { en: `${name} secret question`, zh: null },
      description: { en: "d", zh: null },
      comment: null,
      answerType: "TEXT",
      sources: [],
      reopened: false,
      needsDrafting: true,
    },
  ]);
  return rfi.id;
}

beforeAll(async () => {
  const { db, passwords, businessId } = env();
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  hold = kit.defineRoute(holdViewSpec);
  drafts = kit.defineRoute(ownerDraftSpec);
  list = kit.defineRoute(rfiListSpec);
  const bizB = await createBusiness(db, { name: "Business B (synthetic)" });
  rfiA = await seed(businessId, "hold-a", "Alpha GmbH");
  rfiB = await seed(bizB, "hold-b", "Bravo GmbH");
  await addUser(db, bizB, {
    email: "owner@hb.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.otherOwner = await sessionCookie(env(), "owner@hb.example", "b-owner-password");
});

function call(
  route: RouteHandler,
  method: string,
  id: string,
  path: string,
  cookie: string,
  body?: unknown,
) {
  return route(
    new Request(`${ORIGIN}/api/v1/rfis/${id}${path}`, {
      method,
      headers: {
        cookie,
        origin: ORIGIN,
        "idempotency-key": "hold-test-key-0001",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("GET /rfis/{id}/hold", () => {
  it("own RFI 200 with questions and payment; another business's id 404 without its data", async () => {
    const own = (await (await call(hold, "GET", rfiA, "/hold", cookies.owner)).json()) as {
      questions: { title: string }[];
      payment: { counterparty: string } | null;
    };
    expect(own.questions[0]?.title).toBe("Alpha GmbH secret question");
    expect(own.payment?.counterparty).toBe("Alpha GmbH");
    const res = await call(hold, "GET", rfiB, "/hold", cookies.owner);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain("Bravo");
  });
  it("the viewer can read it", async () => {
    expect((await call(hold, "GET", rfiA, "/hold", cookies.judge)).status).toBe(200);
  });
});

describe("POST /rfis/{id}/drafts", () => {
  const body = { parent_draft_id: null, answers: [{ question_id: "x", text: "t" }] };
  it("another business's RFI is 404", async () => {
    expect((await call(drafts, "POST", rfiB, "/drafts", cookies.owner, body)).status).toBe(404);
  });
  it("the viewer is 403", async () => {
    expect((await call(drafts, "POST", rfiA, "/drafts", cookies.judge, body)).status).toBe(403);
  });
});

describe("GET /rfis carries the payment summary", () => {
  it("only for own payments", async () => {
    const res = (await (
      await list(
        new Request(`${ORIGIN}/api/v1/rfis`, {
          headers: { cookie: cookies.owner, origin: ORIGIN },
        }),
        { params: Promise.resolve({}) },
      )
    ).json()) as { items: { id: string; payment: { counterparty: string } | null }[] };
    expect(res.items.map((i) => i.id)).toEqual([rfiA]);
    expect(res.items[0]?.payment?.counterparty).toBe("Alpha GmbH");
  });
});
