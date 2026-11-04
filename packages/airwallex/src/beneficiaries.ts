// Beneficiaries: create and retrieve. The id field is `id` (not `beneficiary_id`), fixture
// `beneficiary-create-us-usd-local`. A US LOCAL bank account needs `bank_account_category`, which the
// generated schema omits (BL-01, M0-03): the adapter defaults it to "Checking".

import type { Currency, RequestId } from "@carnet/domain";
import { z } from "zod";
import { authed } from "./auth";
import { type Ctx, CurrencySchema, encodeId } from "./wire";

export interface BeneficiaryAddress {
  country_code: string;
  postcode: string;
  street_address: string;
  city: string;
  state?: string;
}

export interface BeneficiaryBankDetails {
  account_currency: string;
  bank_country_code: string;
  account_name: string;
  account_number?: string;
  account_routing_type1?: string;
  account_routing_value1?: string;
  iban?: string;
  swift_code?: string;
  bank_account_category?: string;
}

/** The wire `beneficiary` object (snake_case, as Airwallex validates it). */
export interface BeneficiaryDetails {
  entity_type: "COMPANY" | "PERSONAL";
  company_name?: string;
  first_name?: string;
  last_name?: string;
  address: BeneficiaryAddress;
  bank_details: BeneficiaryBankDetails;
  type: "BANK_ACCOUNT";
}

export interface CreateBeneficiaryInput {
  requestId: RequestId;
  nickname: string;
  beneficiary: BeneficiaryDetails;
  transferMethods: Array<"LOCAL" | "SWIFT">;
}

export interface Beneficiary {
  id: string;
  nickname: string | null;
  transferMethods: string[];
  entityType: string;
  name: string | null;
  bankCountryCode: string;
  accountCurrency: Currency;
  bankName: string | null;
  /** Last four characters of the account number or IBAN, for display. */
  accountHint: string | null;
}

export const BeneficiaryWire = z
  .looseObject({
    id: z.string(),
    nickname: z.string().nullish(),
    transfer_methods: z.array(z.string()).default([]),
    beneficiary: z.looseObject({
      entity_type: z.string(),
      company_name: z.string().nullish(),
      first_name: z.string().nullish(),
      last_name: z.string().nullish(),
      bank_details: z.looseObject({
        account_currency: CurrencySchema,
        bank_country_code: z.string(),
        account_name: z.string().nullish(),
        account_number: z.string().nullish(),
        iban: z.string().nullish(),
        bank_name: z.string().nullish(),
      }),
    }),
  })
  .transform((w): Beneficiary => {
    const b = w.beneficiary;
    const person = [b.first_name, b.last_name].filter(Boolean).join(" ");
    const acct = b.bank_details.account_number ?? b.bank_details.iban ?? null;
    return {
      id: w.id,
      nickname: w.nickname ?? null,
      transferMethods: w.transfer_methods,
      entityType: b.entity_type,
      name: b.company_name ?? (person || b.bank_details.account_name || null),
      bankCountryCode: b.bank_details.bank_country_code,
      accountCurrency: b.bank_details.account_currency,
      bankName: b.bank_details.bank_name ?? null,
      accountHint: acct ? acct.slice(-4) : null,
    };
  });

export function beneficiaryCreateBody(input: CreateBeneficiaryInput): Record<string, unknown> {
  const bank = { ...input.beneficiary.bank_details };
  if (
    bank.bank_country_code === "US" &&
    input.transferMethods.includes("LOCAL") &&
    bank.bank_account_category === undefined
  ) {
    bank.bank_account_category = "Checking";
  }
  return {
    request_id: input.requestId,
    nickname: input.nickname,
    beneficiary: { ...input.beneficiary, bank_details: bank },
    transfer_methods: input.transferMethods,
  };
}

export async function createBeneficiary(
  ctx: Ctx,
  input: CreateBeneficiaryInput,
): Promise<Beneficiary> {
  return authed(ctx.http, ctx.tokens, {
    method: "POST",
    path: "/api/v1/beneficiaries/create",
    json: beneficiaryCreateBody(input),
    schema: BeneficiaryWire,
    retryable: true,
  });
}

export async function getBeneficiary(ctx: Ctx, id: string): Promise<Beneficiary> {
  return authed(ctx.http, ctx.tokens, {
    method: "GET",
    path: `/api/v1/beneficiaries/${encodeId(id)}`,
    schema: BeneficiaryWire,
    retryable: true,
  });
}
