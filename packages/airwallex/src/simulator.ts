// SandboxSimulator port (ADR 0018). The implementation calls only Airwallex `/api/v1/simulation/*`
// endpoints; a static test fails if this file names any other API path. Shapes from the M0-03/M0-04
// fixtures: RFI create/follow_up/close, transfer transition (`next_status`), deposit create.
// A transition sometimes answers 500 although it was applied (BL-01, M0-04), so the implementation
// confirms through an injected `confirmTransfer` (the client's getTransfer) before failing.

import type { Currency, Money, RequestId } from "@carnet/domain";
import { z } from "zod";
import { authed } from "./auth";
import { AirwallexApiError } from "./http";
import { type Rfi, RfiWire } from "./rfis";
import { type Transfer, TransferWire } from "./transfers";
import { type Ctx, CurrencySchema, encodeId, toMoney, toWireAmount, WireDecimal } from "./wire";

export type SimulatedNextStatus =
  | "OVERDUE"
  | "PROCESSING"
  | "SENT"
  | "PAID"
  | "FAILED"
  | "CANCELLED";

export interface SimulatedQuestion {
  answerType: "TEXT" | "ATTACHMENT" | "CONFIRMATION";
  title: string;
  description: string;
  /** A TRANSFER source must already be PROCESSING (400 "Invalid source" while SCHEDULED). */
  sources?: Array<{ id: string; type: "TRANSFER" | "DEPOSIT" | "CHARGE" }>;
}

export interface SimulatedDeposit {
  id: string;
  status: string;
  amount: Money | null;
  currency: Currency;
}

export interface TransitionResult {
  transfer: Transfer;
  /** True when Airwallex answered an error but a fetch showed the transition was applied. */
  confirmedAfterError: boolean;
}

export interface SandboxSimulator {
  createRfi(input: { type: "TRANSACTION"; questions: SimulatedQuestion[] }): Promise<Rfi>;
  /** Reopen answered questions by id and/or append new ones. */
  followUpRfi(
    rfiId: string,
    input: { reopen?: string[]; append?: SimulatedQuestion[] },
  ): Promise<Rfi>;
  closeRfi(rfiId: string): Promise<Rfi>;
  transitionTransfer(
    transferId: string,
    nextStatus: SimulatedNextStatus,
    failureType?: string,
  ): Promise<TransitionResult>;
  /** Credits the global account; the sandbox forces the account's currency (HKD in M0-03). */
  depositFunds(input: {
    globalAccountId: string;
    amount: Money;
    requestId: RequestId;
  }): Promise<SimulatedDeposit>;
}

const DepositWire = z
  .looseObject({
    id: z.string(),
    status: z.string(),
    amount: WireDecimal,
    currency: CurrencySchema,
  })
  .transform(
    (w, ctx): SimulatedDeposit => ({
      id: w.id,
      status: w.status,
      amount: toMoney(w.amount, w.currency, ctx, "amount"),
      currency: w.currency,
    }),
  );

function questionBody(q: SimulatedQuestion): Record<string, unknown> {
  const body: Record<string, unknown> = {
    answer: { type: q.answerType },
    title: { en: q.title },
    description: { en: q.description },
  };
  // without sources the sandbox attaches a synthetic DEPOSIT source (rfi-check7-create-no-sources)
  if (q.sources) body.sources = q.sources;
  return body;
}

/** Whether a fetched status shows that `requested` was applied. A simulated FAILED reads CANCELLED. */
export function transitionApplied(requested: SimulatedNextStatus, fetched: string): boolean {
  if (requested === "FAILED") return fetched === "FAILED" || fetched === "CANCELLED";
  return fetched === requested;
}

export class AirwallexSandboxSimulator implements SandboxSimulator {
  readonly #ctx: Ctx;
  readonly #confirmTransfer: (id: string) => Promise<Transfer>;

  constructor(ctx: Ctx, confirmTransfer: (id: string) => Promise<Transfer>) {
    this.#ctx = ctx;
    this.#confirmTransfer = confirmTransfer;
  }

  #post<T>(path: string, json: unknown, schema: z.ZodType<T>, retryable = false): Promise<T> {
    return authed(this.#ctx.http, this.#ctx.tokens, {
      method: "POST",
      path,
      json,
      schema,
      retryable,
    });
  }

  async createRfi(input: { type: "TRANSACTION"; questions: SimulatedQuestion[] }): Promise<Rfi> {
    return this.#post(
      "/api/v1/simulation/rfis/create",
      { type: input.type, questions: input.questions.map(questionBody) },
      RfiWire,
    );
  }

  async followUpRfi(
    rfiId: string,
    input: { reopen?: string[]; append?: SimulatedQuestion[] },
  ): Promise<Rfi> {
    const questions = [
      ...(input.reopen ?? []).map((id) => ({ id })),
      ...(input.append ?? []).map(questionBody),
    ];
    return this.#post(
      `/api/v1/simulation/rfis/${encodeId(rfiId)}/follow_up`,
      { questions },
      RfiWire,
    );
  }

  async closeRfi(rfiId: string): Promise<Rfi> {
    return this.#post(`/api/v1/simulation/rfis/${encodeId(rfiId)}/close`, {}, RfiWire);
  }

  async transitionTransfer(
    transferId: string,
    nextStatus: SimulatedNextStatus,
    failureType?: string,
  ): Promise<TransitionResult> {
    const body: Record<string, unknown> = { next_status: nextStatus };
    if (failureType) body.failure_type = failureType;
    try {
      const transfer = await this.#post(
        `/api/v1/simulation/transfers/${encodeId(transferId)}/transition`,
        body,
        TransferWire,
      );
      return { transfer, confirmedAfterError: false };
    } catch (err) {
      if (!(err instanceof AirwallexApiError) || err.status < 500) throw err;
      const fetched = await this.#confirmTransfer(transferId).catch(() => null);
      if (fetched && transitionApplied(nextStatus, fetched.status)) {
        this.#ctx.http.logger.warn(
          { transferId, nextStatus, status: err.status },
          "simulator transition errored but was applied",
        );
        return { transfer: fetched, confirmedAfterError: true };
      }
      throw err;
    }
  }

  async depositFunds(input: {
    globalAccountId: string;
    amount: Money;
    requestId: RequestId;
  }): Promise<SimulatedDeposit> {
    return this.#post(
      "/api/v1/simulation/deposit/create",
      {
        global_account_id: input.globalAccountId,
        amount: toWireAmount(input.amount, "amount"),
        currency: input.amount.currency,
        request_id: input.requestId,
      },
      DepositWire,
      true,
    );
  }
}
