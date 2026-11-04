// Current balances, one row per currency (fixture `balances-after-transfer-create`, 46 currencies),
// mapped to domain Money. A held transfer's funds are already out of `available_amount` (debited at
// creation, M0-04 check 8).
import type { Currency, Money } from "@carnet/domain";
import { z } from "zod";
import { authed } from "./auth";
import { type Ctx, CurrencySchema, toMoney, WireDecimal } from "./wire";

export interface Balance {
  currency: Currency;
  available: Money;
  pending: Money;
  reserved: Money;
  total: Money;
}

const BalanceWire = z
  .looseObject({
    currency: CurrencySchema,
    available_amount: WireDecimal,
    pending_amount: WireDecimal,
    reserved_amount: WireDecimal,
    total_amount: WireDecimal,
  })
  .transform((w, ctx): Balance => {
    const m = (v: string, path: string) =>
      toMoney(v, w.currency, ctx, path) ?? { minor: 0n, currency: w.currency };
    return {
      currency: w.currency,
      available: m(w.available_amount, "available_amount"),
      pending: m(w.pending_amount, "pending_amount"),
      reserved: m(w.reserved_amount, "reserved_amount"),
      total: m(w.total_amount, "total_amount"),
    };
  });

export const BalancesWire = z.array(BalanceWire);

export async function getBalances(ctx: Ctx): Promise<Balance[]> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: "/api/v1/balances/current",
    schema: BalancesWire,
    retryable: true,
  });
}
