// A stored plan action as the policy sees it (M3-03).
import type { PlanAction } from "../planner/schemas";
import type { ConversionIntent, OtherIntent } from "./evaluate";

export function intentOf(action: PlanAction): ConversionIntent | OtherIntent {
  if (action.kind !== "convert") return { kind: action.kind };
  const p = action.params;
  return {
    kind: "convert",
    sellCurrency: p.sell_currency,
    buyCurrency: p.buy_currency,
    sellMinor: BigInt(p.sell_minor),
    buyMinor: BigInt(p.buy_minor),
    swiftFeeIncludedMinor: BigInt(p.swift_fee_included_minor),
    obligationCount: p.obligation_ids.length,
    indicativeRate: p.rate,
  };
}
