import { money } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { repoCtx } from "../src/repos/context";
import { createPayment, getPayment } from "../src/repos/payments";
import { createBusiness } from "../src/repos/system";
import { useTestDatabase } from "./harness";

const db = useTestDatabase();

describe("money columns", () => {
  it.each([
    ["2^53 + 1", 2n ** 53n + 1n],
    ["2^60 + 7", 2n ** 60n + 7n],
    ["int64 max", 9_223_372_036_854_775_807n],
  ])("a bigint minor value of %s round-trips unchanged", async (_label, minor) => {
    expect(minor > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    const { app } = db();
    const ctx = repoCtx(app.db, await createBusiness(app.db, { name: "Big Co" }));
    const created = await createPayment(ctx, {
      amount: money(minor, "USD"),
      sourceCurrency: "USD",
      method: "SWIFT",
      reference: "big",
    });
    expect(created.amount).toEqual({ minor, currency: "USD" });
    const read = await getPayment(ctx, created.id);
    expect(read?.amount.minor).toBe(minor);
    expect(typeof read?.amount.minor).toBe("bigint");
    const raw = await app.pool.query<{ amount_minor: string }>(
      "SELECT amount_minor::text FROM payments WHERE id = $1",
      [created.id],
    );
    expect(raw.rows[0]?.amount_minor).toBe(minor.toString());
  });

  it("a zero-decimal currency keeps its minor value (JPY)", async () => {
    const { app } = db();
    const ctx = repoCtx(app.db, await createBusiness(app.db, { name: "Yen Co" }));
    const created = await createPayment(ctx, {
      amount: money(1_000_000n, "JPY"),
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: "jpy",
    });
    expect((await getPayment(ctx, created.id))?.amount).toEqual({
      minor: 1_000_000n,
      currency: "JPY",
    });
  });
});
