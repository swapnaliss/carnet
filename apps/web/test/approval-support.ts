// Test support for the M2-07 approval and respond tests. The RFI is the recorded M0-04 round-1 RFI
// (a TEXT question and an ATTACHMENT question, `firstRoundOpen()`), ingested through the real M2-04
// ingest and then set to DRAFT_READY (the M2-05 drafts table is not on main: the approve body carries the
// draft). Airwallex answers from recorded bodies: the PDF upload, the full respond, the partial/again 4xx.
import {
  createUser,
  type Db,
  getRfi,
  listRfiQuestions,
  listRfis,
  type Rfi,
  type RfiQuestionRow,
  repoCtx,
  storeDocument,
  updateRfi,
} from "@carnet/db";
import type { BusinessId, DocumentId, UserId } from "@carnet/domain";
import { type ApproveBody, approveRfiAnswer } from "../src/server/approvals";
import { memoryLogger } from "../src/server/log";
import type { HandlerContext } from "../src/worker/handlers/index";
import { ingestRfi } from "../src/worker/handlers/rfi";
import { firstRoundOpen, fixtureRfi, newBusiness, type RfiWire, retarget } from "./rfi-support";
import { FetchStub, loadFixture, makeClient } from "./support";

/** A small valid PDF whose bytes differ per call (documents are de-duplicated by hash). */
export const pdfBytes = (tag: string): Uint8Array =>
  new TextEncoder().encode(`%PDF-1.7\n% ${tag}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n`);

export interface Approvable {
  readonly db: Db;
  readonly businessId: BusinessId;
  readonly userId: UserId;
  readonly airwallexRfiId: string;
  readonly rfi: Rfi;
  readonly questions: RfiQuestionRow[];
  readonly documentId: DocumentId;
  readonly docBytes: Uint8Array;
  readonly stub: FetchStub;
  /** The RFI as Airwallex serves it now: tests change it to simulate a change after approval. */
  readonly current: Map<string, RfiWire>;
  readonly ctx: HandlerContext;
  readonly logger: ReturnType<typeof memoryLogger>;
  readonly uploads: () => unknown[];
  readonly responds: () => { path: string; json: unknown }[];
  readonly repo: ReturnType<typeof repoCtx>;
  body: (over?: Partial<ApproveBody>) => ApproveBody;
  approve: (over?: Partial<ApproveBody>, key?: string) => Promise<Response>;
}

export async function setupApprovable(
  db: Db,
  options: { client?: Parameters<typeof makeClient>[1] } = {},
): Promise<Approvable> {
  const { businessId, accountId } = await newBusiness(db);
  const repo = repoCtx(db, businessId);
  const user = await createUser(repo, {
    email: `owner-${crypto.randomUUID()}@t.test`,
    role: "owner",
  });

  const stub = new FetchStub();
  const current = new Map<string, RfiWire>();
  const airwallexRfiId = crypto.randomUUID();
  current.set(airwallexRfiId, retarget(firstRoundOpen(), { id: airwallexRfiId, accountId }));
  stub.on("GET", /^\/api\/v1\/rfis\/[^/]+$/, (call) => {
    const wire = current.get(call.path.split("/").pop() ?? "");
    return wire
      ? Response.json(wire)
      : Response.json({ code: "resource_not_found", message: "not found" }, { status: 404 });
  });
  stub.on("GET", "/api/v1/rfis", () =>
    Response.json({ items: [...current.values()], has_more: false }),
  );
  stub.on("POST", "/api/v1/files/upload", loadFixture("rfi-check2-upload-pdf").response);
  stub.on("POST", /^\/api\/v1\/rfis\/[^/]+\/respond$/, (call) => {
    const id = call.path.split("/")[4] ?? "";
    const answered = retarget(fixtureRfi("rfi-check2-respond-full"), { id, accountId });
    current.set(id, answered);
    return Response.json(answered);
  });
  const airwallex = makeClient(stub, options.client ?? {});
  const logger = memoryLogger();
  const ctx: HandlerContext = { db, airwallex, airwallexWriter: airwallex, logger };

  await ingestRfi(ctx, await airwallex.getRfi(airwallexRfiId), "webhook");
  const stored = await findRfi(repo, airwallexRfiId);
  // The draft is "ready" (M2-05 not on main); the RFI deadline is set relative to now so the TTL rules
  // do not depend on the recorded fixture's 2026-11-17 date.
  await updateRfi(repo, stored.id, {
    state: "DRAFT_READY",
    expiresAt: new Date(Date.now() + 7 * 24 * 3600_000),
  });
  const rfi = (await getRfi(repo, stored.id)) as Rfi;
  const questions = (await listRfiQuestions(repo, rfi.id, rfi.round)).sort(
    (a, b) => a.position - b.position,
  );
  const docBytes = pdfBytes(`invoice-${crypto.randomUUID()}`);
  const stored2 = await storeDocument(repo, {
    kind: "invoice",
    filename: "invoice-1001.pdf",
    mime: "application/pdf",
    bytes: docBytes,
  });

  const body = (over: Partial<ApproveBody> = {}): ApproveBody => ({
    draft_id: "draft-1",
    prompt_version: "draft@test.1",
    rfi_updated_at: rfi.airwallexUpdatedAt.toISOString(),
    answers: questions.map((q) =>
      q.answerType === "ATTACHMENT"
        ? {
            question_id: q.airwallexQuestionId,
            status: "ANSWERED" as const,
            type: "ATTACHMENT" as const,
            text: "",
            document_ids: [stored2.document.id],
            fact_version_ids: ["fv-invoice-1"],
          }
        : {
            question_id: q.airwallexQuestionId,
            status: "ANSWERED" as const,
            type: "TEXT" as const,
            text: "Payment for supplier invoice INV-1001",
            document_ids: [],
            fact_version_ids: ["fv-invoice-1", "fv-contract-2"],
          },
    ),
    ...over,
  });
  const approve = (over: Partial<ApproveBody> = {}, key = `key-${crypto.randomUUID()}`) =>
    approveRfiAnswer(
      { repo, userId: user.id, rfiId: rfi.id, body: body(over), key, requestId: "req-test" },
      { executionEnabled: async () => true },
    );
  return {
    db,
    businessId,
    userId: user.id,
    airwallexRfiId,
    rfi,
    questions,
    documentId: stored2.document.id,
    docBytes,
    stub,
    current,
    ctx,
    logger,
    uploads: () => stub.calls.filter((c) => c.path === "/api/v1/files/upload"),
    responds: () =>
      stub.calls
        .filter((c) => /\/respond$/.test(c.path))
        .map((c) => ({ path: c.path, json: c.json })),
    repo,
    body,
    approve,
  };
}

async function findRfi(repo: ReturnType<typeof repoCtx>, airwallexRfiId: string): Promise<Rfi> {
  const found = (await listRfis(repo)).find((r) => r.airwallexRfiId === airwallexRfiId);
  if (!found) throw new Error("ingest did not store the RFI");
  return found;
}

export interface ApprovalJson {
  approval: {
    id: string;
    status: string;
    hash: string;
    expires_at: string;
    shown_snapshot: unknown;
    end_reason: string | null;
  };
}

/** Approves and returns the stored approval id and hash. */
export async function approved(a: Approvable, over: Partial<ApproveBody> = {}) {
  const res = await a.approve(over);
  if (res.status !== 201) throw new Error(`approve failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as ApprovalJson;
  return { id: json.approval.id, hash: json.approval.hash, approval: json.approval };
}
