// Shared column helpers. Money is always `<name>_minor bigint` plus `currency char(3)` (ADR 0002);
// bigint columns use mode "bigint" so values above 2^53 survive the round trip.
import { type SQL, sql } from "drizzle-orm";
import { bigint, char, timestamp } from "drizzle-orm/pg-core";

export const minor = (name: string) => bigint(name, { mode: "bigint" });
export const currency = (name = "currency") => char(name, { length: 3 });
export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const tstz = (name: string) => timestamp(name, { withTimezone: true });

/** `column IN ('A','B',...)` for a CHECK constraint over a closed set of string values. */
export function oneOf(column: string, values: readonly string[]): SQL {
  const list = values.map((v) => `'${v.replaceAll("'", "''")}'`).join(", ");
  return sql.raw(`"${column}" IN (${list})`);
}

/** ISO 4217 shape: three upper-case letters. The domain's exponent table decides support. */
export function isoCurrency(column: string): SQL {
  return sql.raw(`"${column}" ~ '^[A-Z]{3}$'`);
}

/** `column > 0`. */
export function positive(column: string): SQL {
  return sql.raw(`"${column}" > 0`);
}
