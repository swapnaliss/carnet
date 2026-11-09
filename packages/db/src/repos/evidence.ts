// Evidence links and check snapshots (M2-03). Tenant repository: `ctx` first, every statement scoped
// by `ctx.businessId`. `loadEvidenceContext` gathers everything the pure evidence rules need for one
// payment; it reads facts through `usableFacts` (the function `getUsableFacts` applies to the latest
// version), so an unverified or unconfirmed fact never reaches a rule.
import {
  type CounterpartyId,
  type DocumentId,
  type EvidenceCheck,
  type EvidenceDocument,
  type EvidenceInput,
  type ExtractionState,
  extractionTypeOf,
  type PaymentId,
  parseEvidencePolicy,
  usableFacts,
} from "@carnet/domain";
import { and, asc, desc, eq, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { translateDbError, UniqueViolationError } from "../errors";
import { evidenceChecks, evidenceLinks, payments } from "../schema/index";
import { getBusiness } from "./businesses";
import type { RepoCtx } from "./context";
import { type Counterparty, getCounterparty } from "./counterparties";
import { getLatestFacts, type StoredFactsVersion } from "./document-facts";
import { type DocumentRecord, getDocument } from "./documents";
import { getPayment, type Payment } from "./payments";

export interface EvidenceLink {
  readonly id: string;
  readonly paymentId: PaymentId;
  readonly documentId: DocumentId;
  readonly factVersionId: string | null;
  readonly createdBy: string;
  readonly createdAt: Date;
}

type LinkRow = typeof evidenceLinks.$inferSelect;
const toLink = (r: LinkRow): EvidenceLink => ({
  id: r.id,
  paymentId: r.paymentId as PaymentId,
  documentId: r.documentId as DocumentId,
  factVersionId: r.factVersionId,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
});

export async function listEvidenceLinks(
  ctx: RepoCtx,
  paymentId: PaymentId,
): Promise<EvidenceLink[]> {
  const rows = await ctx.db
    .select()
    .from(evidenceLinks)
    .where(
      and(eq(evidenceLinks.businessId, ctx.businessId), eq(evidenceLinks.paymentId, paymentId)),
    )
    .orderBy(asc(evidenceLinks.createdAt), asc(evidenceLinks.id));
  return rows.map(toLink);
}

export type AttachResult =
  | { readonly status: "created" | "exists"; readonly link: EvidenceLink }
  | { readonly status: "not_found" };

/**
 * Attaches a document to a payment. `not_found` when the payment or the document is not in this
 * business (nothing is written, and the caller answers 404). Attaching twice is a no-op (`exists`).
 */
export async function attachEvidenceLink(
  ctx: RepoCtx,
  input: { paymentId: PaymentId; documentId: DocumentId; createdBy: string },
): Promise<AttachResult> {
  const [payment, document] = await Promise.all([
    getPayment(ctx, input.paymentId),
    getDocument(ctx, input.documentId),
  ]);
  if (!payment || !document) return { status: "not_found" };
  const latest = await getLatestFacts(ctx, input.documentId);
  try {
    const [row] = await ctx.db
      .insert(evidenceLinks)
      .values({
        businessId: ctx.businessId,
        paymentId: input.paymentId,
        documentId: input.documentId,
        factVersionId: latest?.id ?? null,
        createdBy: input.createdBy,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return { status: "created", link: toLink(row) };
  } catch (error) {
    const translated = translateDbError(error);
    if (translated instanceof UniqueViolationError) {
      const [existing] = await ctx.db
        .select()
        .from(evidenceLinks)
        .where(
          and(
            eq(evidenceLinks.businessId, ctx.businessId),
            eq(evidenceLinks.paymentId, input.paymentId),
            eq(evidenceLinks.documentId, input.documentId),
          ),
        );
      if (existing) return { status: "exists", link: toLink(existing) };
    }
    throw translated;
  }
}

/** True when a link of this payment and business was removed. */
export async function removeEvidenceLink(
  ctx: RepoCtx,
  paymentId: PaymentId,
  linkId: string,
): Promise<boolean> {
  const rows = await ctx.db
    .delete(evidenceLinks)
    .where(
      and(
        eq(evidenceLinks.businessId, ctx.businessId),
        eq(evidenceLinks.paymentId, paymentId),
        eq(evidenceLinks.id, linkId),
      ),
    )
    .returning({ id: evidenceLinks.id });
  return rows.length > 0;
}

export interface StoredEvidenceCheck {
  readonly id: string;
  readonly paymentId: PaymentId;
  readonly flag: EvidenceCheck["flag"];
  readonly rules: readonly unknown[];
  readonly reasons: readonly unknown[];
  readonly factVersionIds: readonly string[];
  readonly checkHash: string;
  readonly cause: "link_added" | "link_removed" | "facts_confirmed" | "send";
  readonly createdAt: Date;
}

type CheckRow = typeof evidenceChecks.$inferSelect;
const toStoredCheck = (r: CheckRow): StoredEvidenceCheck => ({
  id: r.id,
  paymentId: r.paymentId as PaymentId,
  flag: r.flag as StoredEvidenceCheck["flag"], // CHECK evidence_checks_flag_check
  rules: r.rules,
  reasons: r.reasons,
  factVersionIds: r.factVersionIds,
  checkHash: r.checkHash,
  cause: r.cause as StoredEvidenceCheck["cause"], // CHECK evidence_checks_cause_check
  createdAt: r.createdAt,
});

/** Stores the snapshot of a check (insert-only). */
export async function insertEvidenceCheck(
  ctx: RepoCtx,
  paymentId: PaymentId,
  check: EvidenceCheck,
  cause: StoredEvidenceCheck["cause"],
): Promise<StoredEvidenceCheck> {
  try {
    const [row] = await ctx.db
      .insert(evidenceChecks)
      .values({
        businessId: ctx.businessId,
        paymentId,
        flag: check.flag,
        rules: [...check.rules],
        reasons: [...check.reasons],
        factVersionIds: [...check.fact_version_ids],
        checkHash: check.check_hash,
        cause,
      })
      .returning();
    if (!row) throw new Error("insert returned no row");
    return toStoredCheck(row);
  } catch (error) {
    throw translateDbError(error);
  }
}

/** Newest first. */
export async function listEvidenceChecks(
  ctx: RepoCtx,
  paymentId: PaymentId,
  limit = 20,
): Promise<StoredEvidenceCheck[]> {
  const rows = await ctx.db
    .select()
    .from(evidenceChecks)
    .where(
      and(eq(evidenceChecks.businessId, ctx.businessId), eq(evidenceChecks.paymentId, paymentId)),
    )
    .orderBy(desc(evidenceChecks.createdAt), desc(evidenceChecks.id))
    .limit(Math.min(Math.max(limit, 1), 200));
  return rows.map(toStoredCheck);
}

export interface EvidenceDocumentView {
  readonly link: EvidenceLink;
  readonly document: DocumentRecord;
  /** The latest stored fact version; null while no extraction has finished. */
  readonly latest: StoredFactsVersion | null;
  readonly extraction: ExtractionState;
}

export interface EvidenceContext {
  readonly payment: Payment;
  readonly counterparty: Counterparty | null;
  readonly documents: readonly EvidenceDocumentView[];
  /** What the pure rules read. */
  readonly input: EvidenceInput;
}

/** Payments to the same counterparty before this one that created an Airwallex transfer. */
export async function countPriorPayments(ctx: RepoCtx, payment: Payment): Promise<number> {
  if (!payment.counterpartyId) return 0;
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(payments)
    .where(
      and(
        eq(payments.businessId, ctx.businessId),
        eq(payments.counterpartyId, payment.counterpartyId as CounterpartyId),
        ne(payments.id, payment.id),
        isNotNull(payments.transferId),
        or(
          lt(payments.createdAt, payment.createdAt),
          and(eq(payments.createdAt, payment.createdAt), lt(payments.id, payment.id)),
        ),
      ),
    );
  return row?.n ?? 0;
}

function extractionOf(kind: string, latest: StoredFactsVersion | null): ExtractionState {
  if (extractionTypeOf(kind) === null) return "none";
  if (!latest) return "pending";
  return latest.status === "EXTRACTION_FAILED" ? "failed" : "done";
}

/** Null when the payment is not in this business. */
export async function loadEvidenceContext(
  ctx: RepoCtx,
  paymentId: PaymentId,
): Promise<EvidenceContext | null> {
  const payment = await getPayment(ctx, paymentId);
  if (!payment) return null;
  const [counterparty, links, business, prior] = await Promise.all([
    payment.counterpartyId ? getCounterparty(ctx, payment.counterpartyId) : null,
    listEvidenceLinks(ctx, paymentId),
    getBusiness(ctx),
    countPriorPayments(ctx, payment),
  ]);
  const documents: EvidenceDocumentView[] = [];
  for (const link of links) {
    const document = await getDocument(ctx, link.documentId);
    if (!document) continue;
    const latest = await getLatestFacts(ctx, link.documentId);
    documents.push({ link, document, latest, extraction: extractionOf(document.kind, latest) });
  }
  const evidenceDocuments: EvidenceDocument[] = documents.map(
    ({ document, latest, extraction }) => {
      const usable = latest ? usableFacts(latest) : [];
      const unusableKeys = latest
        ? latest.facts.filter((f) => !usable.includes(f)).map((f) => f.key)
        : [];
      return {
        documentId: document.id,
        kind: document.kind,
        label: document.filename,
        factVersionId: latest?.id ?? null,
        usable,
        unusableKeys: latest?.status === "EXTRACTED" ? unusableKeys : [],
        extraction,
      };
    },
  );
  return {
    payment,
    counterparty,
    documents,
    input: {
      payment: {
        amountMinor: payment.amount.minor,
        currency: payment.amount.currency,
        payeeName: counterparty?.name ?? "",
        reference: payment.reference,
      },
      documents: evidenceDocuments,
      priorPayments: prior,
      policy: parseEvidencePolicy(business?.evidencePolicy),
    },
  };
}
