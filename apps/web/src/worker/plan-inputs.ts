// The production `PlanInputsLoader` (ADR 0021): what `plan.rerun` plans over, read for one business.
//
//   obligations ......... the database: only what is still to be paid, with the owner-confirmed
//                         criticality or UNCONFIRMED (never a model's proposal)
//   held payments ....... the database: an in-flight transfer (SCHEDULED, PROCESSING, SENT) that an
//                         RFI in a holding state links to. The RFI only sets this flag; money status
//                         is read from the transfer (ADR 0006).
//   balances ............ Airwallex `GET /balances/current` through the gateway (10 s timeout per attempt)
//   indicative FX rates . Airwallex `GET /fx/rates/current`, CLIENT level, one call per (sell, buy) pair
//   reserve floor, policy the business's newest policy version (the database)
//   fees and spread ..... config/fees.json
//
// The Airwallex reads happen in `prefetch`, before the re-run's transaction opens (the pool closes a
// session idle in a transaction after 30 s); `load` then only reads the database.
//
// An obligation is left out once its money is on its way: a payment whose transfer is SCHEDULED,
// PROCESSING, SENT or PAID and not held. Airwallex debits the balance when a transfer is created
// (M0-04 check 8), so the balance already shows it. A FAILED or CANCELLED transfer, and one not yet
// sent, leave the obligation owed. A held payment stays in: the planner's alternate payout is for it.
import { AirwallexApiError, type Balance, type CurrentRate } from "@carnet/airwallex";
import {
  type Db,
  getLatestPolicy,
  listCounterparties,
  listObligations,
  listPayments,
  type Payment,
  paymentHasHoldingRfi,
  repoCtx,
} from "@carnet/db";
import {
  type BusinessId,
  type Currency,
  exponentOf,
  type Money,
  money,
  type PlanInputsInput,
  type PlannerConfig,
  plannerPolicy,
  planningCriticality,
  project,
} from "@carnet/domain";
import { loadPlannerConfig } from "../server/planner-config";
import type { PlanInputsLoader } from "./handlers/plan";

/** The two read-only Airwallex calls the loader makes (the real client satisfies it as it is). */
export interface PlanInputsGateway {
  getBalances(): Promise<readonly Pick<Balance, "currency" | "available">[]>;
  getCurrentRate(input: {
    buyCurrency: Currency;
    sellCurrency: Currency;
    sellAmount: Money;
  }): Promise<CurrentRate>;
}

/** Major units of the sell currency the indicative rate is asked for. */
export const RATE_SELL_MAJOR = 100n;
/** Decimal places kept from the indicative rate (rounded down: the cautious side). */
export const RATE_DECIMALS = 4;

interface Prefetched {
  balances: { currency: Currency; availableMinor: bigint }[];
  fxRates: { sell: Currency; buy: Currency; rate: string; asOf: string }[];
}

/** `buy / sell` as a decimal string with `places` places, rounded down. Inputs are plain decimals. */
export function ratioDecimal(buy: string, sell: string, places: number): string | null {
  const parse = (t: string): { n: bigint; k: number } | null => {
    if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(t)) return null;
    const [w = "0", f = ""] = t.split(".");
    return { n: BigInt(w + f), k: f.length };
  };
  const b = parse(buy);
  const s = parse(sell);
  if (!b || !s || s.n === 0n) return null;
  const q = (b.n * 10n ** BigInt(s.k) * 10n ** BigInt(places)) / (s.n * 10n ** BigInt(b.k));
  const unit = 10n ** BigInt(places);
  return `${q / unit}.${(q % unit).toString().padStart(places, "0")}`;
}

/** The CLIENT-level buy-per-sell rate of a `rates/current` answer, or null when it is unusable. */
export function clientRateOf(rate: CurrentRate): string | null {
  const detail = rate.details.find((d) => d.level === "CLIENT");
  if (!detail) return null;
  const text = ratioDecimal(detail.buyAmount, detail.sellAmount, RATE_DECIMALS);
  return text !== null && /[1-9]/.test(text) ? text : null;
}

/** The start of the UTC day: a rate's `as_of` that does not move on every call (it feeds `inputs_hash`). */
function dayStart(iso: string | null, fallback: Date): string {
  const t = iso ? Date.parse(iso) : Number.NaN;
  const d = new Date(Number.isNaN(t) ? fallback.getTime() : t);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface PlanInputsLoaderDeps {
  /** The pool: `prefetch` reads the obligation currencies with it, outside the re-run's transaction. */
  db: Db;
  gateway: PlanInputsGateway;
  /** Defaults to config/fees.json. */
  config?: PlannerConfig;
}

export function createPlanInputsLoader(deps: PlanInputsLoaderDeps): PlanInputsLoader {
  const config = deps.config ?? loadPlannerConfig();

  async function prefetch(businessId: BusinessId, now: Date): Promise<Prefetched> {
    const rows = await deps.gateway.getBalances();
    const open = await listObligations(repoCtx(deps.db, businessId), 500);
    const targets = new Set<Currency>(open.map((o) => o.currency));
    const positive = rows.filter((b) => b.available.minor > 0n);
    // Keep the rows that can matter: where an obligation is due, or cash that could be converted.
    const keep = new Set<Currency>([...targets, ...positive.map((b) => b.currency)]);
    const balances = rows
      .filter((b) => keep.has(b.currency))
      .map((b) => ({ currency: b.currency, availableMinor: b.available.minor }));

    const pairs = [...targets].flatMap((buy) =>
      positive.filter((s) => s.currency !== buy).map((s) => ({ buy, sell: s.currency })),
    );
    const fxRates: Prefetched["fxRates"] = [];
    await Promise.all(
      pairs.map(async ({ buy, sell }) => {
        try {
          const answer = await deps.gateway.getCurrentRate({
            buyCurrency: buy,
            sellCurrency: sell,
            sellAmount: money(RATE_SELL_MAJOR * 10n ** BigInt(exponentOf(sell)), sell),
          });
          const rate = clientRateOf(answer);
          if (rate !== null) {
            fxRates.push({ sell, buy, rate, asOf: dayStart(answer.createdAt, now) });
          }
        } catch (error) {
          // A pair Airwallex refuses (4xx) is a pair the plan cannot convert; anything else (a
          // timeout, a 5xx) fails the job, which retries with backoff, rather than plan on less.
          if (!(error instanceof AirwallexApiError && error.status >= 400 && error.status < 500)) {
            throw error;
          }
        }
      }),
    );
    return { balances, fxRates };
  }

  const load = async (
    db: Db,
    businessId: BusinessId,
    now: Date,
    prefetched?: unknown,
  ): Promise<PlanInputsInput> => {
    const external = (prefetched as Prefetched | undefined) ?? (await prefetch(businessId, now));
    const rc = repoCtx(db, businessId);
    const [obligations, allPayments, counterparties, policy] = await Promise.all([
      listObligations(rc, 500),
      listPayments(rc, { limit: 500 }),
      listCounterparties(rc),
      getLatestPolicy(rc),
    ]);
    const names = new Map<string, string>(counterparties.map((c) => [c.id, c.name]));
    const byId = new Map<string, Payment>(allPayments.map((p) => [p.id, p]));
    const byObligation = new Map<string, Payment>(
      allPayments.flatMap((p): [string, Payment][] =>
        p.obligationId ? [[p.obligationId, p]] : [],
      ),
    );

    const heldList: Payment[] = [];
    for (const p of allPayments) {
      if (p.transferStatus === null) continue;
      if (!project(p.transferStatus, true).held) continue; // not in flight: an RFI cannot hold it
      if (await paymentHasHoldingRfi(rc, p.id)) heldList.push(p);
    }
    const held = new Map<string, Payment>(heldList.map((p) => [p.id, p]));

    const plannable = obligations.flatMap((o) => {
      const pay = (o.paymentId ? byId.get(o.paymentId) : undefined) ?? byObligation.get(o.id);
      const status = pay?.transferStatus ?? null;
      const onItsWay =
        pay !== undefined &&
        status !== null &&
        !held.has(pay.id) &&
        (status === "SCHEDULED" ||
          status === "PROCESSING" ||
          status === "SENT" ||
          status === "PAID");
      return onItsWay ? [] : [{ o, pay }];
    });

    return {
      businessId,
      now: now.toISOString(),
      balances: external.balances.map((b) => ({ businessId, ...b })),
      held: [...held.values()].map((p) => ({
        businessId,
        paymentId: p.id,
        // The funds a held transfer ties up are in its source currency. The amount stored is the
        // transfer-currency amount: the source amount for a same-currency payout (cross-currency UNVERIFIED).
        currency: p.sourceCurrency,
        amountMinor: p.amount.minor,
      })),
      obligations: plannable.map(({ o, pay }) => ({
        businessId,
        id: o.id,
        payee: names.get(o.counterpartyId) ?? "Unknown payee",
        amountMinor: o.amountMinor,
        currency: o.currency,
        dueAt: o.dueAt.toISOString(),
        criticality: planningCriticality(o),
        paymentId: pay?.id ?? null,
        // Carnet's payments are LOCAL today; an obligation without a payment is planned as SWIFT, the
        // case that costs the flat fee, so the plan never under-funds it.
        payoutMethod: pay?.method === "LOCAL" ? ("LOCAL" as const) : ("SWIFT" as const),
      })),
      reserveFloor: (policy?.reserveFloor ?? []).map((f) => ({
        businessId,
        currency: f.currency,
        minor: f.minor,
      })),
      config,
      fxRates: external.fxRates,
      policy: policy ? plannerPolicy(policy) : { version: 0, hash: "none", autoConvertLimits: [] },
    };
  };

  return Object.assign(load, { prefetch });
}
