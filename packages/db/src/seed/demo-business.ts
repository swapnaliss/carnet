// The demo tenant that scripts/setup.ts creates on every environment (synthetic data only).
// Fixed ids make the seed idempotent: INSERT ... ON CONFLICT DO NOTHING, safe to run any number of times.
// The demo users (M1-04 `seedDemoUsers`) belong to this business; the dataset (M0-08) is loaded in M2.
import type { BusinessId, CounterpartyId } from "@carnet/domain";
import type { Db } from "../client";
import { businesses, counterparties } from "../schema/index";

export const DEMO_BUSINESS_ID = "6f1c2a7e-3b4d-4e5f-8a9b-0c1d2e3f4a5b" as BusinessId;
export const DEMO_BUSINESS_NAME = "Demo business";
/** Placeholder supplier; its Airwallex beneficiary id is attached when the dataset is loaded (M2). */
export const DEMO_COUNTERPARTY_ID = "8a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d" as CounterpartyId;

export interface DemoBusinessResult {
  businessId: BusinessId;
  /** Rows inserted by this call (0 on a re-run). */
  inserted: { businesses: number; counterparties: number };
}

/** Creates the demo business and its placeholder counterparty if they do not exist yet. */
export async function ensureDemoBusiness(db: Db): Promise<DemoBusinessResult> {
  const b = await db
    .insert(businesses)
    .values({ id: DEMO_BUSINESS_ID, name: DEMO_BUSINESS_NAME, timezone: "Asia/Singapore" })
    .onConflictDoNothing({ target: businesses.id })
    .returning({ id: businesses.id });
  const c = await db
    .insert(counterparties)
    .values({
      id: DEMO_COUNTERPARTY_ID,
      businessId: DEMO_BUSINESS_ID,
      name: "Demo supplier (placeholder)",
      country: "SG",
      beneficiaryId: null,
    })
    .onConflictDoNothing({ target: counterparties.id })
    .returning({ id: counterparties.id });
  return {
    businessId: DEMO_BUSINESS_ID,
    inserted: { businesses: b.length, counterparties: c.length },
  };
}
