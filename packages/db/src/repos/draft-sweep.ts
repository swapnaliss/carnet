// System-level lookup for the drafting timeout sweeper (M2-05). Takes `db`: it scans every business to
// find RFIs that entered DRAFTING and never got a draft (the job crashed, died after its retries, or was
// enqueued before the handler existed). The caller continues per RFI with a tenant context.
import type { BusinessId, RfiId } from "@carnet/domain";
import { and, eq, lt, notExists } from "drizzle-orm";
import type { Db } from "../client";
import { drafts, rfis } from "../schema/index";

export interface StuckDraftingRfi {
  readonly businessId: BusinessId;
  readonly rfiId: RfiId;
  readonly round: number;
}

/** RFIs in DRAFTING since before `olderThan` that have no draft for their current round. */
export async function listStuckDraftingRfis(
  db: Db,
  olderThan: Date,
  limit = 50,
): Promise<StuckDraftingRfi[]> {
  const rows = await db
    .select({ businessId: rfis.businessId, rfiId: rfis.id, round: rfis.round })
    .from(rfis)
    .where(
      and(
        eq(rfis.state, "DRAFTING"),
        lt(rfis.updatedAt, olderThan),
        notExists(
          db
            .select({ one: drafts.id })
            .from(drafts)
            .where(and(eq(drafts.rfiId, rfis.id), eq(drafts.round, rfis.round))),
        ),
      ),
    )
    .limit(limit);
  return rows.map((r) => ({
    businessId: r.businessId as BusinessId,
    rfiId: r.rfiId as RfiId,
    round: r.round,
  }));
}
