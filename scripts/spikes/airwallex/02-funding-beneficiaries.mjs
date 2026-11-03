import { call, must, newId, record, requireEnv, sleep } from "./lib.mjs";

requireEnv();

export const US = {
  entity_type: "COMPANY",
  company_name: "Northwind Test Supplies LLC",
  address: {
    country_code: "US",
    postcode: "10001",
    street_address: "350 Fifth Avenue",
    city: "New York",
    state: "US-NY",
  },
  bank_details: {
    account_currency: "USD",
    bank_country_code: "US",
    account_name: "Northwind Test Supplies LLC",
    account_number: "1234567890",
    account_routing_type1: "aba",
    account_routing_value1: "021000021",
    bank_account_category: "Checking",
  },
  type: "BANK_ACCOUNT",
};
export const DE = {
  entity_type: "COMPANY",
  company_name: "Nordlicht Test GmbH",
  address: {
    country_code: "DE",
    postcode: "10115",
    street_address: "Invalidenstrasse 1",
    city: "Berlin",
  },
  bank_details: {
    account_currency: "EUR",
    bank_country_code: "DE",
    account_name: "Nordlicht Test GmbH",
    iban: "DE89370400440532013000",
  },
  type: "BANK_ACCOUNT",
};

export async function balances(name) {
  const r = await call(name, "GET", "/api/v1/balances/current");
  return Object.fromEntries(
    must(r)
      .filter((b) => b.total_amount || b.pending_amount || b.reserved_amount)
      .map((b) => [b.currency, b]),
  );
}

export async function run() {
  const before = await balances("balances-before-funding");
  // global accounts + simulated deposit
  const ga = must(await call("global-accounts-list", "GET", "/api/v1/global_accounts"));
  const acct = ga.items.find((a) => a.status !== "CLOSED") ?? ga.items[0];
  const dep = must(
    await call("simulation-deposit-create", "POST", "/api/v1/simulation/deposit/create", {
      body: {
        global_account_id: acct.id,
        amount: 1000,
        currency: acct.required_features?.[0]?.currency ?? "HKD",
        request_id: newId(),
      },
    }),
  );
  await sleep(1500);
  await call("simulation-deposit-fetch", "GET", `/api/v1/global_accounts/${acct.id}/transactions`);
  const after = await balances("balances-after-funding");
  record("balances-funding-delta", { before, after, deposit: dep });

  // schemas
  await call(
    "beneficiary-schema-us-usd-local",
    "POST",
    "/api/v1/beneficiary_api_schemas/generate",
    {
      body: {
        bank_country_code: "US",
        account_currency: "USD",
        entity_type: "COMPANY",
        transfer_method: "LOCAL",
      },
    },
  );
  await call(
    "beneficiary-schema-de-eur-swift",
    "POST",
    "/api/v1/beneficiary_api_schemas/generate",
    {
      body: {
        bank_country_code: "DE",
        account_currency: "EUR",
        entity_type: "COMPANY",
        transfer_method: "SWIFT",
      },
    },
  );
  // validate: one bad, one good
  const bad = structuredClone(US);
  bad.bank_details.account_routing_value1 = "123";
  await call("beneficiary-validate-bad", "POST", "/api/v1/beneficiaries/validate", {
    body: { beneficiary: bad, transfer_methods: ["LOCAL"] },
  });
  await call("beneficiary-validate-us-local", "POST", "/api/v1/beneficiaries/validate", {
    body: { beneficiary: US, transfer_methods: ["LOCAL"] },
  });
  // create both (new request_id each run)
  const us = must(
    await call("beneficiary-create-us-usd-local", "POST", "/api/v1/beneficiaries/create", {
      body: {
        request_id: newId(),
        nickname: "spike-us-usd",
        beneficiary: US,
        transfer_methods: ["LOCAL"],
      },
    }),
  );
  const de = must(
    await call("beneficiary-create-de-eur-swift", "POST", "/api/v1/beneficiaries/create", {
      body: {
        request_id: newId(),
        nickname: "spike-de-eur",
        beneficiary: DE,
        transfer_methods: ["SWIFT"],
      },
    }),
  );
  await call("beneficiary-fetch-us", "GET", `/api/v1/beneficiaries/${us.id}`);
  return { usBeneficiaryId: us.id, deBeneficiaryId: de.id };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(await run());
