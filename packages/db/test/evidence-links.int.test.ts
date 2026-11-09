// M2-03: evidence links, check snapshots and the context the pure rules read. Every statement is scoped
// by business; a snapshot is insert-only for the app role; a fact the rules may use is verified or
// owner-confirmed (the image-only case included).
import { readFileSync } from "node:fs";
import {
  type BusinessId,
  checkEvidence,
  type DocumentId,
  EVIDENCE_FLAGS,
  type ExtractedFact,
  type PaymentId,
} from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import { insertFactsVersion } from "../src/repos/document-facts";
import {
  attachEvidenceLink,
  countPriorPayments,
  insertEvidenceCheck,
  listEvidenceChecks,
  listEvidenceLinks,
  loadEvidenceContext,
  removeEvidenceLink,
} from "../src/repos/evidence";
import {
  createCounterparty,
  createPayment,
  repoCtx,
  storeDocument,
  updatePaymentTransfer,
} from "../src/repos/index";
import { createBusiness } from "../src/repos/system";
import { createUser } from "../src/repos/users";
import { EVIDENCE_FLAG_VALUES } from "../src/schema/evidence";
import { sqlStateOf, useTestDatabase } from "./harness";

const db = useTestDatabase();
const PERMISSION_DENIED = "42501";

const pdf = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../../../fixtures/dataset/${name}`, import.meta.url)));

const fact = (
  key: string,
  parsed: ExtractedFact["parsed"],
  over: Partial<ExtractedFact> = {},
): ExtractedFact => ({
  key,
  value: parsed?.type === "text" ? parsed.text : `${key}`,
  parsed,
  quote: `${key} quote`,
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...over,
});
const total = (minor: string) => fact("total", { type: "amount", minor, currency: "USD" });
const supplier = (name: string) => fact("supplier", { type: "text", text: name });

let biz: BusinessId;
let other: BusinessId;
let userId: string;
let cp: Awaited<ReturnType<typeof createCounterparty>>;
let payment: Awaited<ReturnType<typeof createPayment>>;
let invoice: DocumentId;
let contract: DocumentId;

beforeAll(async () => {
  const { app } = db();
  biz = await createBusiness(app.db, { name: "evidence-co" });
  other = await createBusiness(app.db, { name: "other-co" });
  const ctx = repoCtx(app.db, biz);
  userId = (await createUser(ctx, { email: "o@evidence.example.com", name: "O", role: "owner" }))
    .id;
  cp = await createCounterparty(ctx, { name: "Harbor Print Co.", country: "US" });
  payment = await createPayment(ctx, {
    counterpartyId: cp.id,
    amount: { minor: 480_000n, currency: "USD" },
    sourceCurrency: "USD",
    method: "LOCAL",
    reference: "INV-1",
  });
  invoice = (
    await storeDocument(ctx, {
      kind: "invoice",
      filename: "inv-harbor-001.pdf",
      mime: "application/pdf",
      bytes: pdf("inv-harbor-001.pdf"),
    })
  ).document.id;
  contract = (
    await storeDocument(ctx, {
      kind: "contract",
      filename: "contract-harbor.pdf",
      mime: "application/pdf",
      bytes: pdf("contract-harbor.pdf"),
    })
  ).document.id;
});

describe("links", () => {
  it("attaches once, lists in order, and removes by id", async () => {
    const ctx = repoCtx(db().app.db, biz);
    const a = await attachEvidenceLink(ctx, {
      paymentId: payment.id,
      documentId: invoice,
      createdBy: userId,
    });
    expect(a.status).toBe("created");
    const again = await attachEvidenceLink(ctx, {
      paymentId: payment.id,
      documentId: invoice,
      createdBy: userId,
    });
    expect(again.status).toBe("exists");
    if (a.status === "not_found" || again.status === "not_found") throw new Error("unreachable");
    expect(again.link.id).toBe(a.link.id);
    await attachEvidenceLink(ctx, {
      paymentId: payment.id,
      documentId: contract,
      createdBy: userId,
    });
    const links = await listEvidenceLinks(ctx, payment.id);
    expect(links.map((l) => l.documentId)).toEqual([invoice, contract]);
    expect(await removeEvidenceLink(ctx, payment.id, links[1]?.id ?? "")).toBe(true);
    expect(await removeEvidenceLink(ctx, payment.id, links[1]?.id ?? "")).toBe(false);
    expect((await listEvidenceLinks(ctx, payment.id)).map((l) => l.documentId)).toEqual([invoice]);
  });

  it("records the fact version current at attach time", async () => {
    const ctx = repoCtx(db().app.db, biz);
    const { version } = await insertFactsVersion(ctx, {
      documentId: contract,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: [
        fact("clause_parties", {
          type: "text",
          text: "Northwind Studio Ltd (Buyer) and Harbor Print Co. (Supplier).",
        }),
      ],
      extractionKey: "ev-1",
    });
    const r = await attachEvidenceLink(ctx, {
      paymentId: payment.id,
      documentId: contract,
      createdBy: userId,
    });
    expect(r.status === "created" && r.link.factVersionId).toBe(version.id);
  });

  it("another business sees nothing and cannot attach or remove", async () => {
    const foreign = repoCtx(db().app.db, other);
    expect(await listEvidenceLinks(foreign, payment.id)).toEqual([]);
    expect(
      (
        await attachEvidenceLink(foreign, {
          paymentId: payment.id,
          documentId: invoice,
          createdBy: userId,
        })
      ).status,
    ).toBe("not_found");
    const own = repoCtx(db().app.db, biz);
    const links = await listEvidenceLinks(own, payment.id);
    expect(await removeEvidenceLink(foreign, payment.id, links[0]?.id ?? "")).toBe(false);
    expect(await listEvidenceLinks(own, payment.id)).toHaveLength(links.length);
    expect(await loadEvidenceContext(foreign, payment.id)).toBeNull();
  });

  it("a document of another business cannot be attached to this business's payment", async () => {
    const foreign = repoCtx(db().app.db, other);
    const foreignDoc = (
      await storeDocument(foreign, {
        kind: "invoice",
        filename: "inv-lakeside-001.pdf",
        mime: "application/pdf",
        bytes: pdf("inv-lakeside-001.pdf"),
      })
    ).document.id;
    const own = repoCtx(db().app.db, biz);
    expect(
      (
        await attachEvidenceLink(own, {
          paymentId: payment.id,
          documentId: foreignDoc,
          createdBy: userId,
        })
      ).status,
    ).toBe("not_found");
  });
});

describe("check snapshots", () => {
  it("stores the flag with the fact version ids it used, newest first, and cannot be changed", async () => {
    const ctx = repoCtx(db().app.db, biz);
    const context = await loadEvidenceContext(ctx, payment.id);
    if (!context) throw new Error("no context");
    const check = checkEvidence(context.input);
    const stored = await insertEvidenceCheck(ctx, payment.id, check, "link_added");
    expect(stored.flag).toBe(check.flag);
    expect(stored.checkHash).toBe(check.check_hash);
    expect(stored.factVersionIds).toEqual(check.fact_version_ids);
    await insertEvidenceCheck(ctx, payment.id, check, "send");
    expect((await listEvidenceChecks(ctx, payment.id)).map((c) => c.cause)).toEqual([
      "send",
      "link_added",
    ]);
    expect(await listEvidenceChecks(repoCtx(db().app.db, other), payment.id)).toEqual([]);

    expect(await sqlStateOf(db().appUrl, "UPDATE evidence_checks SET flag = 'strong'")).toBe(
      PERMISSION_DENIED,
    );
    expect(await sqlStateOf(db().appUrl, "DELETE FROM evidence_checks")).toBe(PERMISSION_DENIED);
  });

  it("the flag values equal the domain's", () => {
    expect([...EVIDENCE_FLAG_VALUES]).toEqual([...EVIDENCE_FLAGS]);
  });
});

describe("loadEvidenceContext", () => {
  it("hands the rules only verified or owner-confirmed facts and says what is not usable", async () => {
    const ctx = repoCtx(db().app.db, biz);
    await insertFactsVersion(ctx, {
      documentId: invoice,
      source: "model",
      status: "EXTRACTED",
      textLayer: true,
      facts: [
        total("480000"),
        supplier("Harbor Print Co."),
        fact(
          "buyer",
          { type: "text", text: "N" },
          { quote_verified: false, issues: ["quote_not_found"] },
        ),
      ],
      extractionKey: "ev-inv",
    });
    const c = await loadEvidenceContext(ctx, payment.id);
    const inv = c?.input.documents.find((d) => d.documentId === invoice);
    expect(inv?.usable.map((f) => f.key)).toEqual(["total", "supplier"]);
    expect(inv?.unusableKeys).toEqual(["buyer"]);
    expect(inv?.extraction).toBe("done");
    expect(c?.input.payment).toMatchObject({
      amountMinor: 480_000n,
      currency: "USD",
      payeeName: "Harbor Print Co.",
    });
    expect(c?.input.policy.contractRequiredAboveMinor).toEqual({});
  });

  it("an image-only version is unusable until an owner confirms it", async () => {
    const ctx = repoCtx(db().app.db, biz);
    const scan = (
      await storeDocument(ctx, {
        kind: "invoice",
        filename: "inv-nordlicht-scan-001.pdf",
        mime: "application/pdf",
        bytes: pdf("inv-nordlicht-scan-001.pdf"),
      })
    ).document.id;
    const scanned = fact(
      "total",
      { type: "amount", minor: "310000", currency: "EUR" },
      { quote_verified: false, needs_confirmation: true, issues: ["no_text_layer"] },
    );
    await insertFactsVersion(ctx, {
      documentId: scan,
      source: "model",
      status: "EXTRACTED",
      textLayer: false,
      facts: [scanned],
      extractionKey: "scan-1",
    });
    await attachEvidenceLink(ctx, { paymentId: payment.id, documentId: scan, createdBy: userId });
    const before = (await loadEvidenceContext(ctx, payment.id))?.input.documents.find(
      (d) => d.documentId === scan,
    );
    expect(before?.usable).toEqual([]);
    expect(before?.unusableKeys).toEqual(["total"]);
    await insertFactsVersion(ctx, {
      documentId: scan,
      source: "owner",
      status: "EXTRACTED",
      textLayer: false,
      facts: [{ ...scanned, needs_confirmation: false }],
      ownerConfirmedBy: userId,
    });
    const after = (await loadEvidenceContext(ctx, payment.id))?.input.documents.find(
      (d) => d.documentId === scan,
    );
    expect(after?.usable.map((f) => f.key)).toEqual(["total"]);
    expect(after?.unusableKeys).toEqual([]);
  });

  it("a document whose extraction has not produced a version is pending; a failure is failed", async () => {
    const ctx = repoCtx(db().app.db, biz);
    const fresh = (
      await storeDocument(ctx, {
        kind: "purchase_order",
        filename: "po-harbor-001.pdf",
        mime: "application/pdf",
        bytes: pdf("po-harbor-001.pdf"),
      })
    ).document.id;
    await attachEvidenceLink(ctx, { paymentId: payment.id, documentId: fresh, createdBy: userId });
    const pending = (await loadEvidenceContext(ctx, payment.id))?.input.documents.find(
      (d) => d.documentId === fresh,
    );
    expect(pending?.extraction).toBe("pending");
    await insertFactsVersion(ctx, {
      documentId: fresh,
      source: "model",
      status: "EXTRACTION_FAILED",
      failure: "MODEL_ERROR",
      textLayer: true,
      facts: [],
      extractionKey: "fail-1",
    });
    const failed = (await loadEvidenceContext(ctx, payment.id))?.input.documents.find(
      (d) => d.documentId === fresh,
    );
    expect(failed?.extraction).toBe("failed");
    expect(failed?.unusableKeys).toEqual([]);
  });

  it("counts earlier payments to the counterparty that have a transfer", async () => {
    const ctx = repoCtx(db().app.db, biz);
    const mk = (reference: string) =>
      createPayment(ctx, {
        counterpartyId: cp.id,
        amount: { minor: 100n, currency: "USD" },
        sourceCurrency: "USD",
        method: "LOCAL",
        reference,
      });
    const first = await mk("first");
    const second = await mk("second");
    expect(await countPriorPayments(ctx, second)).toBe(0); // the first has no transfer yet (a draft)
    await updatePaymentTransfer(ctx, first.id as PaymentId, {
      transferId: "tr_1",
      transferStatus: "SCHEDULED",
      transferUpdatedAt: new Date(),
    });
    expect(await countPriorPayments(ctx, second)).toBe(1);
    expect(await countPriorPayments(ctx, first)).toBe(0);
  });
});
