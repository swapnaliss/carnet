// Current balances, one row per currency, amounts in major units (fixture `balances-after-transfer-create`).
// A held transfer's funds are already out of `available_amount` (debited at creation, M0-04 check 8).
import { z } from "zod";
import { authed } from "./auth";
import { type Ctx, Currency, type MajorAmount, WireAmount } from "./wire";

export interface Balance {
  currency: string;
  availableAmount: MajorAmount;
  pendingAmount: MajorAmount;
  reservedAmount: MajorAmount;
  totalAmount: MajorAmount;
}

const BalanceWire = z
  .looseObject({
    currency: Currency,
    available_amount: WireAmount,
    pending_amount: WireAmount,
    reserved_amount: WireAmount,
    total_amount: WireAmount,
  })
  .transform(
    (w): Balance => ({
      currency: w.currency,
      availableAmount: w.available_amount,
      pendingAmount: w.pending_amount,
      reservedAmount: w.reserved_amount,
      totalAmount: w.total_amount,
    }),
  );

export const BalancesWire = z.array(BalanceWire);

export async function getBalances(ctx: Ctx): Promise<Balance[]> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: "/api/v1/balances/current",
    schema: BalancesWire,
    retryable: true,
  });
}
