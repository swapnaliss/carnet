// M2-07: the approve and reject endpoints (the exact production specs, on a route kit over real sessions).
// Roles (viewer 403, approver and owner allowed), cross-tenant ids (404), idempotency, and every refusal:
// NEEDS_OWNER answers, a stale draft, a changed RFI, TTL and the expiry margin, the kill switch.
import { getRfi, listApprovalsForSubject, listAudit, storeDocument, updateRfi } from "@carnet/db";
import { approvalHash } from "@carnet/domain";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import {
  type ApprovalSnapshot,
  approvalRouteSpecs,
  approveRfiAnswer,
} from "../../src/server/approvals";
import { type Approvable, setupApprovable } from "../approval-support";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";
import { blockedCalls } from "../support";

const env = setupAuthTestEnv();
let a: Approvable;
const cookies = { owner: "", approver: "", viewer: "", other: "" };
let latestDraft = "draft-1";
let executionEnabled = true;
const clock = () => new Date();
let create: RouteHandler;
let list: RouteHandler;
let reject: RouteHandler;
let seeded = 0;

afterAll(() => expect(blockedCalls).toEqual([]));

beforeAll(async () => {
  const { db, passwords } = env();
  a = await setupApprovable(db);
  const kit = createRouteKit({
    authz: env().authz,
    db: () => db,
    logger: () => env().rt.logger,
    now: () => new Date(),
  });
  const specs = approvalRouteSpecs({
    now: () => clock(),
    ttlMinutes: 30,
    isLatestDraft: async (_rc, _rfi, draftId) => draftId === latestDraft,
    executionEnabled: async () => executionEnabled,
  });
  create = kit.defineRoute(specs.create);
  list = kit.defineRoute(specs.list);
  reject = kit.defineRoute(specs.reject);
  const pw = "route-test-password";
  await addUser(db, a.businessId, { email: "own@appr.test", role: "owner", password: pw });
  await addUser(db, a.businessId, { email: "app@appr.test", role: "approver", password: pw });
  await addUser(db, a.businessId, { email: "view@appr.test", role: "viewer", password: pw });
  cookies.owner = await sessionCookie(env(), "own@appr.test", pw);
  cookies.approver = await sessionCookie(env(), "app@appr.test", pw);
  cookies.viewer = await sessionCookie(env(), "view@appr.test", pw);
  // The fixture business of the auth setup is "another business" for every call below.
  cookies.other = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
});

function call(
  route: RouteHandler,
  cookie: string,
  params: Record<string, string>,
  body?: unknown,
  key: string | null = `k-${++seeded}-${crypto.randomUUID()}`,
) {
  return route(
    new Request(`${ORIGIN}/api/v1/rfis/${params.id ?? "x"}/approvals`, {
      method: body === undefined && key === null ? "GET" : "POST",
      headers: {
        cookie,
        origin: ORIGIN,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(key === null ? {} : { "idempotency-key": key }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { params: Promise.resolve(params) },
  );
}

const params = () => ({ id: a.rfi.id as string });
const state = async () => (await getRfi(a.repo, a.rfi.id))?.state;

describe("POST /rfis/{id}/approvals: who and what", () => {
  it("a viewer is 403 and nothing is stored", async () => {
    const res = await call(create, cookies.viewer, params(), a.body());
    expect(res.status).toBe(403);
    expect(await listApprovalsForSubject(a.repo, "rfi_answer", a.rfi.id)).toEqual([]);
    expect(await state()).toBe("DRAFT_READY");
  });

  it("another business's RFI id is 404, with no hint and nothing stored", async () => {
    const res = await call(create, cookies.other, params(), a.body());
    expect(res.status).toBe(404);
    expect(await state()).toBe("DRAFT_READY");
    expect((await call(list, cookies.other, params(), undefined, null)).status).toBe(404);
  });

  it("an answer that needs the owner is refused (412) and the RFI stays DRAFT_READY", async () => {
    const body = a.body();
    body.answers[0] = {
      ...(body.answers[0] as (typeof body.answers)[number]),
      status: "NEEDS_OWNER",
    };
    const res = await call(create, cookies.owner, params(), body);
    expect(res.status).toBe(412);
    expect(JSON.stringify(await res.json())).toContain("NEEDS_OWNER_ANSWER");
    expect(await state()).toBe("DRAFT_READY");
  });

  it("a partial, duplicate or unknown-question answer set is refused", async () => {
    const full = a.body();
    const partial = { ...full, answers: full.answers.slice(0, 1) };
    expect(
      JSON.stringify(await (await call(create, cookies.owner, params(), partial)).json()),
    ).toContain("UNANSWERED_QUESTIONS");
    const dup = { ...full, answers: [...full.answers, full.answers[0]] };
    expect(
      JSON.stringify(await (await call(create, cookies.owner, params(), dup)).json()),
    ).toContain("DUPLICATE_ANSWER");
    const unknown = {
      ...full,
      answers: [...full.answers, { ...full.answers[0], question_id: "not-a-question" }],
    };
    expect(
      JSON.stringify(await (await call(create, cookies.owner, params(), unknown)).json()),
    ).toContain("UNKNOWN_QUESTION");
    expect(await state()).toBe("DRAFT_READY");
  });

  it("a stale draft (not the latest) is a 409; a changed RFI since the approver looked is a 409", async () => {
    latestDraft = "draft-2";
    const stale = await call(create, cookies.owner, params(), a.body());
    expect(stale.status).toBe(409);
    latestDraft = "draft-1";
    const changed = await call(
      create,
      cookies.owner,
      params(),
      a.body({ rfi_updated_at: "2026-11-09T00:00:00Z" }),
    );
    expect(changed.status).toBe(409);
    expect(await state()).toBe("DRAFT_READY");
  });

  it("another business's document, or a PNG, cannot be attached", async () => {
    const png = await storeDocument(a.repo, {
      kind: "other",
      filename: "shot.png",
      mime: "image/png",
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
    });
    const body = a.body();
    const idx = body.answers.findIndex((x) => x.type === "ATTACHMENT");
    body.answers[idx] = {
      ...(body.answers[idx] as (typeof body.answers)[number]),
      document_ids: [png.document.id],
    };
    const res = await call(create, cookies.owner, params(), body);
    expect(res.status).toBe(412);
    expect(JSON.stringify(await res.json())).toContain("UNSUPPORTED_ATTACHMENT");
    const missing = a.body();
    missing.answers[idx] = {
      ...(missing.answers[idx] as (typeof missing.answers)[number]),
      document_ids: [crypto.randomUUID() as never],
    };
    expect((await call(create, cookies.owner, params(), missing)).status).toBe(404);
  });

  it("with execution off nothing can be approved", async () => {
    executionEnabled = false;
    const res = await call(create, cookies.owner, params(), a.body());
    executionEnabled = true;
    expect(res.status).toBe(412);
    expect(JSON.stringify(await res.json())).toContain("KILL_SWITCH");
    expect(await state()).toBe("DRAFT_READY");
  });

  it("validates the body strictly (unknown keys, empty answers, missing key header)", async () => {
    expect((await call(create, cookies.owner, params(), { ...a.body(), extra: 1 })).status).toBe(
      400,
    );
    expect((await call(create, cookies.owner, params(), { ...a.body(), answers: [] })).status).toBe(
      400,
    );
    expect((await call(create, cookies.owner, params(), a.body(), null)).status).toBe(400);
  });
});

describe("approve, replay, reject", () => {
  it("an approver approves: APPROVED approval bound to the shown snapshot, RFI APPROVED, job queued, audited", async () => {
    const key = "approve-key-0001";
    const res = await call(create, cookies.approver, params(), a.body(), key);
    expect(res.status).toBe(201);
    const { approval } = (await res.json()) as {
      approval: {
        id: string;
        status: string;
        hash: string;
        expires_at: string;
        shown_snapshot: ApprovalSnapshot;
      };
    };
    expect(approval.status).toBe("APPROVED");
    // The hash is SHA-256 over exactly the subject in the snapshot the approver was shown.
    expect(approvalHash(approval.shown_snapshot.subject)).toBe(approval.hash);
    expect(approval.shown_snapshot.subject.answers.map((x) => x.type).sort()).toEqual([
      "ATTACHMENT",
      "TEXT",
    ]);
    expect(approval.shown_snapshot.attachments[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await state()).toBe("APPROVED");
    const jobs = await env().db.execute(
      sql`SELECT payload FROM outbox_jobs WHERE kind = 'rfi.respond'`,
    );
    expect(jobs.rows.map((r) => r.payload as { approvalId: string; hash: string })).toContainEqual({
      businessId: a.businessId,
      approvalId: approval.id,
      hash: approval.hash,
    });
    const audit = await listAudit(a.repo, 100);
    const granted = audit.find((e) => e.action === "approval.granted");
    expect(granted?.actorId).toBeTruthy();
    expect(JSON.stringify(granted?.data)).not.toContain("Payment for supplier invoice");

    // Same key and body: the stored response is replayed, no second approval.
    const replay = await call(create, cookies.approver, params(), a.body(), key);
    expect(replay.status).toBe(201);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(((await replay.json()) as { approval: { id: string } }).approval.id).toBe(approval.id);
    expect(await listApprovalsForSubject(a.repo, "rfi_answer", a.rfi.id)).toHaveLength(1);
    // Same key, different body: refused.
    const reused = await call(
      create,
      cookies.approver,
      params(),
      a.body({ draft_id: "draft-other" }),
      key,
    );
    expect(reused.status).toBe(422);
    // The RFI is APPROVED now: a second approval of it is a 409.
    expect((await call(create, cookies.owner, params(), a.body())).status).toBe(409);
  });

  it("another business cannot read or reject it (404); a viewer cannot reject (403); the owner can", async () => {
    const [approval] = await listApprovalsForSubject(a.repo, "rfi_answer", a.rfi.id);
    if (!approval) throw new Error("no approval");
    const p = { id: a.rfi.id as string, approvalId: approval.id as string };
    expect((await call(reject, cookies.other, p, undefined, "reject-key-x1")).status).toBe(404);
    expect((await call(reject, cookies.viewer, p, undefined, "reject-key-x2")).status).toBe(403);
    expect((await call(list, cookies.viewer, params(), undefined, null)).status).toBe(200);
    const res = await call(reject, cookies.owner, p, undefined, "reject-key-x3");
    expect(res.status).toBe(200);
    expect(
      ((await res.json()) as { approval: { status: string; end_reason: string } }).approval,
    ).toMatchObject({
      status: "REJECTED",
      end_reason: "REJECTED_BY_USER",
    });
    // Rejected: the draft returns to the owner and may be approved again.
    expect(await state()).toBe("DRAFT_READY");
    expect((await call(reject, cookies.owner, p, undefined, "reject-key-x4")).status).toBe(409);
    expect((await call(create, cookies.owner, params(), a.body())).status).toBe(201);
    expect(await state()).toBe("APPROVED");
    const all = await listApprovalsForSubject(a.repo, "rfi_answer", a.rfi.id);
    expect(all.map((x) => x.status).sort()).toEqual(["APPROVED", "REJECTED"]);
    // A foreign approval id under an own RFI id is 404 too.
    const foreign = { id: a.rfi.id as string, approvalId: crypto.randomUUID() };
    expect((await call(reject, cookies.owner, foreign, undefined, "reject-key-x5")).status).toBe(
      404,
    );
  });
});

describe("TTL", () => {
  const now = new Date();
  const deps = { now: () => now, ttlMinutes: 30, executionEnabled: async () => true };
  const approveWith = (b: Approvable, key: string) =>
    approveRfiAnswer(
      { repo: b.repo, userId: b.userId, rfiId: b.rfi.id, body: b.body(), key, requestId: "r" },
      deps,
    );
  const expiresIn = async (res: Response) =>
    Date.parse(((await res.json()) as { approval: { expires_at: string } }).approval.expires_at) -
    now.getTime();

  it("is APPROVAL_TTL_MINUTES, capped at the RFI expiry minus 5 minutes, refused when not ahead", async () => {
    const plain = await setupApprovable(env().db);
    const res = await approveWith(plain, "ttl-key-0001");
    expect(res.status).toBe(201);
    expect(await expiresIn(res)).toBe(30 * 60_000);

    // The RFI expires in 20 minutes: capped at 15 minutes from now, never past expires_at - 5 min.
    const near = await setupApprovable(env().db);
    await updateRfi(near.repo, near.rfi.id, { expiresAt: new Date(now.getTime() + 20 * 60_000) });
    expect(await expiresIn(await approveWith(near, "ttl-key-0002"))).toBe(15 * 60_000);

    // The RFI expires in 4 minutes: too close to expiry, nothing approved.
    const tooClose = await setupApprovable(env().db);
    await updateRfi(tooClose.repo, tooClose.rfi.id, {
      expiresAt: new Date(now.getTime() + 4 * 60_000),
    });
    await expect(approveWith(tooClose, "ttl-key-0003")).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect((await getRfi(tooClose.repo, tooClose.rfi.id))?.state).toBe("DRAFT_READY");
    expect(await listApprovalsForSubject(tooClose.repo, "rfi_answer", tooClose.rfi.id)).toEqual([]);
  });
});
