// Payee status links (M3-06), system side: the public page has no session and no tenant context, so
// it finds a link by the SHA-256 of the token and gets back only what the page may render. Nothing
// here returns an amount, a reference, a counterparty or a business name.
import {
  type DisclosureLevel,
  isDisclosureLevel,
  isTransferStatus,
  type TransferStatus,
} from "@carnet/domain";
import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { payeeLinks, payments } from "../schema/index";

export interface PayeeLinkTarget {
  readonly linkId: string;
  readonly paymentId: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly disclosureLevel: DisclosureLevel;
  readonly transferStatus: TransferStatus | null;
  /** When the transfer last changed (falls back to the payment's last update). */
  readonly updatedAt: Date;
}

export async function findPayeeLinkByTokenHash(
  db: Db,
  tokenHash: string,
): Promise<PayeeLinkTarget | null> {
  const [row] = await db
    .select({
      linkId: payeeLinks.id,
      paymentId: payeeLinks.paymentId,
      tokenHash: payeeLinks.tokenHash,
      expiresAt: payeeLinks.expiresAt,
      revokedAt: payeeLinks.revokedAt,
      disclosureLevel: payeeLinks.disclosureLevel,
      transferStatus: payments.transferStatus,
      transferUpdatedAt: payments.transferUpdatedAt,
      paymentUpdatedAt: payments.updatedAt,
    })
    .from(payeeLinks)
    .innerJoin(payments, eq(payments.id, payeeLinks.paymentId))
    .where(eq(payeeLinks.tokenHash, tokenHash));
  if (!row) return null;
  if (!isDisclosureLevel(row.disclosureLevel)) {
    throw new Error(`unknown disclosure level in database: ${row.disclosureLevel}`);
  }
  if (row.transferStatus !== null && !isTransferStatus(row.transferStatus)) {
    throw new Error(`unknown transfer status in database: ${row.transferStatus}`);
  }
  return {
    linkId: row.linkId,
    paymentId: row.paymentId,
    tokenHash: row.tokenHash,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    disclosureLevel: row.disclosureLevel,
    transferStatus: row.transferStatus,
    updatedAt: row.transferUpdatedAt ?? row.paymentUpdatedAt,
  };
}

/** Records a view of a live link (`last_viewed_at` is the only per-viewer datum kept). */
export async function touchPayeeLinkViewed(db: Db, linkId: string, now: Date): Promise<void> {
  await db.update(payeeLinks).set({ lastViewedAt: now }).where(eq(payeeLinks.id, linkId));
}
