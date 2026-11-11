// The dataset's payees (M0-08, fixtures/dataset/counterparties.json) as counterparties of the demo
// business, for the live core-demo run (M2-09). No API creates counterparties, so the run needs them
// seeded. Fixed ids make it idempotent (INSERT ... ON CONFLICT DO NOTHING): safe to run any number of
// times, and it never deletes or updates anything. Synthetic data only.
import type { BusinessId, CounterpartyId } from "@carnet/domain";
import type { Db } from "../client";
import { counterparties } from "../schema/index";
import { DEMO_BUSINESS_ID } from "./demo-business";

export interface DemoDatasetCounterparty {
  readonly id: CounterpartyId;
  readonly name: string;
  readonly country: string;
}

/** Names and countries as in fixtures/dataset/counterparties.json; ids are uuid v5 of `carnet.demo.counterparty.<key>`. */
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
