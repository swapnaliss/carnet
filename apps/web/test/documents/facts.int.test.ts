// M2-02 acceptance tests on the web side: the upload queues extraction, the worker handler stores
// facts versions from recorded model replies, and the list and confirm routes enforce who may do what.

import {
  createBusiness,
  type Db,
  listAudit,
  listFactVersions,
  type OutboxJob,
  repoCtx,
  schema,
} from "@carnet/db";
import {
  ApiErrorSchema,
  type DocumentId,
  DocumentUploadResponseSchema,
  FactsListResponseSchema,
  FactsVersionSchema,
} from "@carnet/domain";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRecording, replayTransport } from "../../../../packages/agent/evals/extraction/run";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import { factsRouteSpecs } from "../../src/server/documents/facts-routes";
import { DOCUMENT_JOB_KIND } from "../../src/server/documents/jobs";
import { createDocumentExtractHandler } from "../../src/worker/handlers/extract";
import type { HandlerContext } from "../../src/worker/handlers/index";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";
import { dataset, documentRoutes, getRequest, uploadRequest } from "./support";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", other: "" };
let upload: RouteHandler;
let list: RouteHandler;
let confirm: RouteHandler;

process.env.ANTHROPIC_API_KEY ||= "replay-not-a-key";

beforeAll(async () => {
  const { db, passwords, authz, rt } = env();
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
  upload = documentRoutes(env(), {
    limits: {
      maxBytes: 5 * 1024 * 1024,
      sessionMaxFiles: 1000,
      sessionMaxBytes: 1024 * 1024 * 1024,
      windowMs: 3_600_000,
    },
  }).upload;
  const kit = createRouteKit({
    authz,
    db: () => db,
    logger: () => rt.logger,
    now: () => new Date(),
  });
  const specs = factsRouteSpecs();
  list = kit.defineRoute(specs.list);
  confirm = kit.defineRoute(specs.confirm);
});

const ctxFor = (id: string) => ({ params: Promise.resolve({ id }) });
const confirmCtx = (id: string, version: number) => ({
  params: Promise.resolve({ id, version: String(version) }),
});

async function put(file: string, kind = "invoice", cookie = cookies.owner) {
  const res = await upload(
    uploadRequest(cookie, { bytes: dataset(file), name: file.split("/").pop() ?? file }, { kind }),
  );
  expect([200, 201]).toContain(res.status);
  return DocumentUploadResponseSchema.parse(await res.json());
}

async function extractJobs(documentId: string): Promise<OutboxJob[]> {
  const rows = await env().db.select().from(schema.outboxJobs);
  return rows
    .filter(
      (r) =>
        r.kind === DOCUMENT_JOB_KIND.extract &&
        (r.payload as { documentId?: string }).documentId === documentId,
    )
    .map(
      (r) => ({ ...r, runAfter: r.runAfter, lockedAt: r.lockedAt ?? null }) as unknown as OutboxJob,
    );
}

const handlerCtx = (db: Db): HandlerContext => ({
  db,
  airwallex: {} as unknown as HandlerContext["airwallex"],
  logger: env().rt.logger as unknown as HandlerContext["logger"],
});

/** Runs the worker handler for the document's queued job over a recorded model reply. */
async function runJob(documentId: string, recording: string) {
  const requests: number[] = [];
  const inner = replayTransport(loadRecording(recording));
  const handler = createDocumentExtractHandler({
    transport: async (input, init) => {
      requests.push(1);
      return inner(input, init);
    },
  });
  const [job] = await extractJobs(documentId);
  if (!job) throw new Error("no extract job queued");
  await handler(job.payload, handlerCtx(env().db), job);
  return { requests: requests.length, job };
}

const get = (id: string, cookie = cookies.owner) =>
  list(getRequest(`/api/v1/documents/${id}/facts`, cookie), ctxFor(id));

function post(id: string, version: number, body: unknown, cookie = cookies.owner) {
  return confirm(
    new Request(`${ORIGIN}/api/v1/documents/${id}/facts/${version}/confirm`, {
      method: "POST",
      headers: { cookie, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    confirmCtx(id, version),
  );
}

describe("job wiring", () => {
  it("a new invoice queues one document.extract job; a duplicate and an `other` document queue none", async () => {
    const doc = await put("inv-harbor-001.pdf");
    const jobs = await extractJobs(doc.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ documentId: doc.id });

    await put("inv-harbor-001.pdf", "invoice", cookies.approver);
    expect(await extractJobs(doc.id)).toHaveLength(1);

    const other = await put("po-harbor-001.pdf", "other");
    expect(await extractJobs(other.id)).toHaveLength(0);
  });
});

describe("extraction stores a version and publishes the event in one transaction", () => {
  let docId: string;
  it("stores version 1 with verified facts and queues document.extracted", async () => {
    const doc = await put("inv-lakeside-002.pdf");
    docId = doc.id;
    const run = await runJob(doc.id, "inv-lakeside-002");
    expect(run.requests).toBe(1);

    const res = await get(doc.id);
    expect(res.status).toBe(200);
    const body = FactsListResponseSchema.parse(await res.json());
    expect(body.versions).toHaveLength(1);
    const v = body.versions[0];
    expect(v).toMatchObject({
      version: 1,
      source: "model",
      status: "EXTRACTED",
      failure: null,
      text_layer: true,
    });
    expect(v?.model).toBe("claude-haiku-5-5");
    expect(v?.quotes_verified).toBe(true);
    expect(v?.owner_confirmed_by).toBeNull();
    expect(body.usable?.facts.length).toBe(v?.facts.length);
    const total = body.usable?.facts.find((f) => f.key === "total");
    expect(total?.parsed).toEqual({ type: "amount", minor: "98000", currency: "USD" });

    const events = (await env().db.select().from(schema.outboxJobs)).filter(
      (r) => r.kind === DOCUMENT_JOB_KIND.extracted,
    );
    expect(events.some((e) => (e.payload as { documentId: string }).documentId === doc.id)).toBe(
      true,
    );
  });

  it("AC5: the injection document's flags are stored on the version", async () => {
    const body = FactsListResponseSchema.parse(await (await get(docId)).json());
    const flags = body.versions[0]?.injection_flags ?? [];
    expect(flags.length).toBeGreaterThan(0);
    expect(flags.map((f) => f.rule)).toContain("ignore-previous");
  });

  it("AC8: running the same job again stores nothing new and makes no second model call", async () => {
    const again = await runJob(docId, "inv-lakeside-002");
    expect(again.requests).toBe(0);
    const versions = await listFactVersions(
      repoCtx(env().db, env().businessId),
      docId as DocumentId,
    );
    expect(versions).toHaveLength(1);
  });
});

describe("AC3 and AC4: image-only documents need an owner", () => {
  let docId: string;
  it("every fact needs confirmation and none is usable", async () => {
    const doc = await put("scans/inv-nordlicht-scan-001.png");
    docId = doc.id;
    await runJob(doc.id, "inv-nordlicht-scan-001-png");
    const body = FactsListResponseSchema.parse(await (await get(doc.id)).json());
    expect(body.versions[0]?.text_layer).toBe(false);
    expect(body.versions[0]?.facts.every((f) => f.needs_confirmation && !f.quote_verified)).toBe(
      true,
    );
    expect(body.usable?.facts).toEqual([]);
  });

  it("confirm: viewer and approver 403, no session 401, another business 404, bad body 400", async () => {
    expect((await post(docId, 1, {}, cookies.judge)).status).toBe(403);
    expect((await post(docId, 1, {}, cookies.approver)).status).toBe(403);
    expect((await post(docId, 1, {}, "")).status).toBe(401);
    expect((await post(docId, 1, {}, cookies.other)).status).toBe(404);
    expect((await post(docId, 1, { extra: true })).status).toBe(400);
    const unknownKey = await post(docId, 1, {
      corrections: [{ key: "approve_payment", value: "yes" }],
    });
    expect(unknownKey.status).toBe(400);
    const badValue = await post(docId, 1, { corrections: [{ key: "total", value: "lots" }] });
    expect(badValue.status).toBe(400);
    expect((await post(docId, 7, {})).status).toBe(404);
    expect(
      await listFactVersions(repoCtx(env().db, env().businessId), docId as DocumentId),
    ).toHaveLength(1);
  });

  it("the owner's confirmation with a correction creates version 2 and stores who confirmed", async () => {
    const res = await post(docId, 1, { corrections: [{ key: "total", value: "EUR 3,100.00" }] });
    expect(res.status).toBe(201);
    const v = FactsVersionSchema.parse(await res.json());
    expect(v).toMatchObject({ version: 2, source: "owner", status: "EXTRACTED" });
    expect(v.owner_confirmed_by).toBeTruthy();
    const total = v.facts.find((f) => f.key === "total");
    expect(total).toMatchObject({
      parsed: { type: "amount", minor: "310000", currency: "EUR" },
      issues: ["owner_entered"],
      needs_confirmation: false,
    });

    const body = FactsListResponseSchema.parse(await (await get(docId)).json());
    expect(body.versions.map((x) => x.version)).toEqual([2, 1]);
    expect(body.versions[1]?.owner_confirmed_by).toBeNull(); // version 1 is untouched
    expect(body.usable).toMatchObject({ version: 2, confirmed: true });
    expect(body.usable?.facts.length).toBe(v.facts.length);

    const audit = await listAudit(repoCtx(env().db, env().businessId));
    expect(audit.some((a) => a.action === "document.facts_confirmed")).toBe(true);
  });

  it("confirming a version that is no longer the latest is a 409", async () => {
    expect((await post(docId, 1, {})).status).toBe(409);
    // The latest is already confirmed and nothing changes: also 409.
    expect((await post(docId, 2, {})).status).toBe(409);
  });
});

describe("AC7: with agents disabled, extraction fails visibly and manual entry still works", () => {
  it("stores EXTRACTION_FAILED, never empty facts, and the owner can enter the values", async () => {
    const { db } = env();
    await db
      .update(schema.systemFlags)
      .set({ agentsEnabled: false })
      .where(eq(schema.systemFlags.id, 1));
    try {
      const doc = await put("inv-rhein-001.pdf");
      const run = await runJob(doc.id, "inv-rhein-001");
      expect(run.requests).toBe(0);
      const body = FactsListResponseSchema.parse(await (await get(doc.id)).json());
      expect(body.versions[0]).toMatchObject({
        status: "EXTRACTION_FAILED",
        failure: "AGENTS_DISABLED",
        facts: [],
      });
      expect(body.usable?.facts).toEqual([]);

      const empty = await post(doc.id, 1, {});
      expect(empty.status).toBe(400);
      const entered = await post(doc.id, 1, {
        corrections: [
          { key: "invoice_number", value: "RD-2026-1180" },
          { key: "total", value: "EUR 7,200.00" },
        ],
      });
      expect(entered.status).toBe(201);
      const after = FactsListResponseSchema.parse(await (await get(doc.id)).json());
      expect(after.usable?.facts.map((f) => f.key)).toEqual(["invoice_number", "total"]);
    } finally {
      await db
        .update(schema.systemFlags)
        .set({ agentsEnabled: true })
        .where(eq(schema.systemFlags.id, 1));
    }
  });
});

describe("AC9: tenancy", () => {
  it("another business gets 404 for the facts and cannot see the document's versions", async () => {
    const doc = await put("po-rhein-001.pdf", "purchase_order");
    await runJob(doc.id, "po-rhein-001");
    expect((await get(doc.id, cookies.other)).status).toBe(404);
    const res = await get(doc.id, cookies.other);
    expect(ApiErrorSchema.parse(await res.json()).error.code).toBe("NOT_FOUND");
    expect((await get(doc.id, "")).status).toBe(401);
    expect((await get(doc.id, cookies.judge)).status).toBe(200); // the viewer may read
  });
});
