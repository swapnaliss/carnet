// Tenancy (ADR 0012): every tenant repository function takes `ctx` first and scopes every statement
// by `ctx.businessId`. There is no function that reads a tenant table without one.
import { type BusinessId, type Currency, isCurrency, type Money, money } from "@carnet/domain";
import type { Db } from "../client";

export interface RepoCtx {
  readonly businessId: BusinessId;
  /** A database handle or an open transaction. */
  readonly db: Db;
}

export function repoCtx(db: Db, businessId: BusinessId): RepoCtx {
  return { db, businessId };
}

export function currencyFromDb(value: string): Currency {
  if (!isCurrency(value)) throw new Error(`unsupported currency in database: ${value}`);
  return value;
}

export function moneyFromDb(minor: bigint, currency: string): Money {
  return money(minor, currencyFromDb(currency));
}
