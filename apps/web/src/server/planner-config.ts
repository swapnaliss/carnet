// Loads config/fees.json into the planner's `PlannerConfig` (M3-02). The planner takes the fees from
// the object it is given and holds none of its own; this is the one place the file is read.
//
// Provenance of the values (see config/fees.json):
//  - swiftPayoutFee EUR 13.41: the SWIFT EUR sandbox transfer fixture shows `fee_amount: 13.41`
//    (fixtures/airwallex/transfer-create-swift-eur.json, M0-03). The builder guide's EUR 12.85 was
//    not reproduced there; the fixture value is used.
//  - heldFundsVisibleInBalances true: M0-04 check 8, the balance is debited when the transfer is
//    created and `pending_amount` / `reserved_amount` stay 0 (docs/evidence/airwallex-rfi-contract.md).
//  - fxSpreadBps and deferGraceDays are product assumptions, not Airwallex facts.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Currency,
  isCurrency,
  type PlannerConfig,
  PlannerConfigSchema,
  parseMajor,
} from "@carnet/domain";
import { z } from "zod";

const FeesFileSchema = z.object({
  heldFundsVisibleInBalances: z.boolean(),
  /** Major-unit decimal strings by currency, exactly as Airwallex reports fees. */
  swiftPayoutFee: z.record(z.string(), z.string()),
  fxSpreadBps: z.number().int(),
  deferGraceDays: z.object({ "2": z.number().int(), "3": z.number().int() }),
});

export function plannerConfigFromJson(json: unknown): PlannerConfig {
  const file = FeesFileSchema.parse(json);
  const swiftPayoutFee = Object.entries(file.swiftPayoutFee).map(([code, major]) => {
    if (!isCurrency(code)) throw new Error(`fees.json: unsupported currency ${code}`);
    const currency: Currency = code;
    return { currency, minor: parseMajor(major, currency).minor };
  });
  return PlannerConfigSchema.parse({ ...file, swiftPayoutFee });
}

export const DEFAULT_FEES_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../config/fees.json",
);

export function loadPlannerConfig(path: string = DEFAULT_FEES_PATH): PlannerConfig {
  return plannerConfigFromJson(JSON.parse(readFileSync(path, "utf8")));
}
