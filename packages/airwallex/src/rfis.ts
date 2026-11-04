// Transaction RFIs: list, retrieve, respond (docs/evidence/airwallex-rfi-contract.md).
// - An RFI never changes a transfer's money status; derive status from the transfer.
// - Respond must answer every question of the active request in one call (400 "Please answer all
//   questions in the request" otherwise, fixture `rfi-check2-respond-partial-text`); the wrapper checks
//   this before sending when given the active question ids.
// - Respond carries no request_id, so it is never retried automatically; after a timeout fetch the RFI
//   (ANSWERED means done, ADR 0007).
import { z } from "zod";
import { authed } from "./auth";
import { AirwallexInputError } from "./http";
import { type Ctx, encodeId } from "./wire";

export const RFI_STATUSES = ["ACTION_REQUIRED", "ANSWERED", "CLOSED"] as const;
export type RfiStatus = (typeof RFI_STATUSES)[number];

export interface RfiSource {
  id: string;
  type: string;
}

export interface LocalizedText {
  en: string | null;
  zh: string | null;
}

export interface RfiQuestion {
  id: string;
  /** TEXT, ATTACHMENT, CONFIRMATION, ... */
  answerType: string;
  title: LocalizedText;
  description: LocalizedText;
  comment: string | null;
  trigger: string | null;
  sources: RfiSource[];
  /** The recorded answer on an answered question (wire shape), else null. */
  answer: Record<string, unknown> | null;
}

export interface RfiRequest {
  questions: RfiQuestion[];
  createdAt: string | null;
  updatedAt: string | null;
  expiresAt: string | null;
}

export interface Rfi {
  id: string;
  type: string;
  subType: string | null;
  status: RfiStatus;
  accountId: string | null;
  activeRequest: RfiRequest | null;
  answeredRequests: RfiRequest[];
  createdAt: string;
  updatedAt: string;
}

const Localized = z
  .union([z.string(), z.looseObject({ en: z.string().nullish(), zh: z.string().nullish() })])
  .nullish()
  .transform(
    (v): LocalizedText =>
      typeof v === "string" ? { en: v, zh: null } : { en: v?.en ?? null, zh: v?.zh ?? null },
  );

const QuestionWire = z
  .looseObject({
    id: z.string(),
    answer: z.looseObject({ type: z.string() }),
    title: Localized,
    description: Localized,
    comment: z.string().nullish(),
    trigger: z.string().nullish(),
    sources: z.array(z.looseObject({ id: z.string(), type: z.string() })).default([]),
  })
  .transform((w): RfiQuestion => {
    const { type, ...rest } = w.answer;
    return {
      id: w.id,
      answerType: type,
      title: w.title,
      description: w.description,
      comment: w.comment ?? null,
      trigger: w.trigger ?? null,
      sources: w.sources.map((s) => ({ id: s.id, type: s.type })),
      answer: Object.keys(rest).length > 0 ? { type, ...rest } : null,
    };
  });

const RequestWire = z
  .looseObject({
    questions: z.array(QuestionWire),
    created_at: z.string().nullish(),
    updated_at: z.string().nullish(),
    expires_at: z.string().nullish(),
  })
  .transform(
    (w): RfiRequest => ({
      questions: w.questions,
      createdAt: w.created_at ?? null,
      updatedAt: w.updated_at ?? null,
      expiresAt: w.expires_at ?? null,
    }),
  );

export const RfiWire = z
  .looseObject({
    id: z.string(),
    type: z.string(),
    sub_type: z.string().nullish(),
    status: z.enum(RFI_STATUSES),
    account_id: z.string().nullish(),
    active_request: RequestWire.nullish(),
    answered_requests: z.array(RequestWire).nullish(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .transform(
    (w): Rfi => ({
      id: w.id,
      type: w.type,
      subType: w.sub_type ?? null,
      status: w.status,
      accountId: w.account_id ?? null,
      activeRequest: w.active_request ?? null,
      answeredRequests: w.answered_requests ?? [],
      createdAt: w.created_at,
      updatedAt: w.updated_at,
    }),
  );

const RfiList = z.looseObject({
  items: z.array(RfiWire),
  has_more: z.boolean().nullish(),
});

export interface ListRfisInput {
  statuses?: RfiStatus[];
  types?: string[];
  fromCreatedAt?: string;
  endCreatedAt?: string;
  page?: string;
  pageSize?: number;
}

export async function listRfis(
  ctx: Ctx,
  input: ListRfisInput = {},
): Promise<{ items: Rfi[]; hasMore: boolean }> {
  const res = await authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: "/api/v1/rfis",
    query: {
      statuses: input.statuses?.join(","),
      types: input.types?.join(","),
      from_created_at: input.fromCreatedAt,
      end_created_at: input.endCreatedAt,
      page: input.page,
      page_size: input.pageSize,
    },
    schema: RfiList,
    retryable: true,
  });
  return { items: res.items, hasMore: res.has_more ?? false };
}

export async function getRfi(ctx: Ctx, id: string): Promise<Rfi> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: `/api/v1/rfis/${encodeId(id)}`,
    schema: RfiWire,
    retryable: true,
  });
}

export type RfiAnswer =
  | { type: "TEXT"; text: string; comment?: string }
  | { type: "ATTACHMENT"; attachments: Array<{ file_id: string }>; comment?: string }
  | { type: "CONFIRMATION"; confirmed: boolean; comment?: string };

export interface RespondRfiInput {
  rfiId: string;
  answers: Array<{ questionId: string; answer: RfiAnswer }>;
  /**
   * The ids of the active request's questions. When given, the wrapper refuses to send unless the
   * answers cover exactly these questions (Airwallex rejects partial responses).
   */
  activeQuestionIds?: string[];
}

export function respondBody(input: RespondRfiInput): Record<string, unknown> {
  const ids = input.answers.map((a) => a.questionId);
  if (new Set(ids).size !== ids.length) {
    throw new AirwallexInputError("respond: a question is answered twice");
  }
  if (input.activeQuestionIds) {
    const want = new Set(input.activeQuestionIds);
    const missing = [...want].filter((id) => !ids.includes(id));
    const extra = ids.filter((id) => !want.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new AirwallexInputError(
        `respond must answer every question: missing ${missing.length}, unknown ${extra.length}`,
      );
    }
  }
  for (const { answer } of input.answers) {
    if (answer.type === "TEXT" && answer.text.trim() === "") {
      throw new AirwallexInputError("respond: an empty TEXT answer");
    }
    if (answer.type === "ATTACHMENT" && answer.attachments.length === 0) {
      throw new AirwallexInputError("respond: an ATTACHMENT answer without files");
    }
  }
  return { questions: input.answers.map((a) => ({ id: a.questionId, answer: a.answer })) };
}

export async function respondRfi(ctx: Ctx, input: RespondRfiInput): Promise<Rfi> {
  return authed(ctx.http, ctx.tokens, {
    method: "POST",
    path: `/api/v1/rfis/${encodeId(input.rfiId)}/respond`,
    json: respondBody(input),
    schema: RfiWire,
    retryable: false,
  });
}
