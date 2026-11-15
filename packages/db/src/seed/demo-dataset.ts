// The dataset's payees (M0-08, fixtures/dataset/counterparties.json) as counterparties of the demo
// business, for the live core-demo run (M2-09). No API creates counterparties, so the run needs them
// seeded. Fixed ids make it idempotent (INSERT ... ON CONFLICT DO NOTHING): safe to run any number of
// times, and it never deletes or updates anything. Synthetic data only.
//
// M3-07 adds, on the owner's decision (issue #40): an SGD payroll payee (not in the generated
// counterparties.json: the demo only funds payroll, it never pays it, so it needs no bank details or
// Airwallex beneficiary), and the demo business's first auto-FX policy (`ensureDemoPolicy`).
import type { BusinessId, CounterpartyId, PolicyContentInput } from "@carnet/domain";
import { sql } from "drizzle-orm";
import { type Db, withTransaction } from "../client";
import { repoCtx } from "../repos/context";
import { createPolicyVersion, getLatestPolicy } from "../repos/policies";
import { counterparties } from "../schema/index";
import { DEMO_BUSINESS_ID } from "./demo-business";

export interface DemoDatasetCounterparty {
  readonly id: CounterpartyId;
  readonly name: string;
  readonly country: string;
}

/** Names and countries as in fixtures/dataset/counterparties.json (plus the M3-07 SGD payroll payee); ids are uuid v5 of `carnet.demo.counterparty.<key>`. */
export const DEMO_DATASET_COUNTERPARTIES: readonly DemoDatasetCounterparty[] = [
  {
    id: "970431ea-f5c8-56e4-9ce1-5e5a7d12e1a3" as CounterpartyId,
    name: "Harbor Print Co.",
    country: "US",
  },
  {
    id: "6b297011-01a1-51c9-8df5-9ab5bfb73049" as CounterpartyId,
    name: "Lakeside Freight LLC",
    country: "US",
  },
  {
    id: "b00e8103-24c1-55b6-8f20-900dad53f0f2" as CounterpartyId,
    name: "Brightline Media Inc.",
    country: "US",
  },
  {
    id: "cddd0d04-57d0-5d0d-b4cd-2e7bae4fb9e8" as CounterpartyId,
    name: "Rheinblick Druck GmbH",
    country: "DE",
  },
  {
    id: "a7ee1ffc-343f-5562-8be5-2d4352c66a02" as CounterpartyId,
    name: "Nordlicht Software GmbH",
    country: "DE",
  },
  {
    id: "18dfa35f-d0eb-58c9-b90b-15143f9024e0" as CounterpartyId,
    name: "Altstadt Verlag GmbH",
    country: "DE",
  },
  {
    // M3-07: the payroll payee of the demo goal (SGD). uuid v5 (URL namespace) of
    // `carnet.demo.counterparty.lioncity`, like the others.
    id: "411e7182-55c6-5efc-a891-2b08f8382c06" as CounterpartyId,
    name: "Lion City Payroll Pte. Ltd.",
    country: "SG",
  },
];

export interface DemoDatasetResult {
  businessId: BusinessId;
  /** Rows inserted by this call (0 on a re-run). */
  inserted: number;
}

/** Adds the dataset's payees to the demo business if they are not there yet. The business must exist. */
export async function ensureDemoDataset(
  db: Db,
  businessId: BusinessId = DEMO_BUSINESS_ID,
): Promise<DemoDatasetResult> {
  const rows = await db
    .insert(counterparties)
    .values(
      DEMO_DATASET_COUNTERPARTIES.map((c) => ({
        id: c.id,
        businessId,
        name: c.name,
        country: c.country,
      })),
    )
    .onConflictDoNothing({ target: counterparties.id })
    .returning({ id: counterparties.id });
  return { businessId, inserted: rows.length };
}

/**
 * The demo auto-FX policy (owner decision on issue #40, M3-07): a USD conversion of at most USD 5,000.00
 * may run without a person, at most USD 10,000.00 a day, keeping USD 100.00 in the account, with a fresh
 * quote within 100 bps of the indicative rate and at most 300 s old.
 */
export const DEMO_POLICY: PolicyContentInput = {
  reserveFloor: [{ currency: "USD", minor: "10000" }],
  perActionLimit: [{ currency: "USD", minor: "500000" }],
  dailyCap: [{ currency: "USD", minor: "1000000" }],
  slippageBps: 100,
  quoteFreshnessSeconds: 300,
};

export interface DemoPolicyResult {
  /** True when this call stored version 1; false when the business already had a policy. */
  readonly created: boolean;
  readonly version: number;
  readonly hash: string;
}

/**
 * Stores DEMO_POLICY as version 1 only when the business has no policy at all. An existing policy, of any
 * content, is left alone: this never adds a second version, and never updates or deletes one (policies
 * are append-only). The check runs under the same advisory lock `createPolicyVersion` takes, so two
 * concurrent seeds store one version.
 */
export async function ensureDemoPolicy(
  db: Db,
  businessId: BusinessId = DEMO_BUSINESS_ID,
): Promise<DemoPolicyResult> {
  return withTransaction(db, async (tx) => {
    const ctx = repoCtx(tx, businessId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`policy:${businessId}`}))`);
    const existing = await getLatestPolicy(ctx);
    if (existing) return { created: false, version: existing.version, hash: existing.hash };
    const created = await createPolicyVersion(ctx, DEMO_POLICY);
    return { created: true, version: created.version, hash: created.hash };
  });
}
