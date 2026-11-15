import { balances } from "./02-funding-beneficiaries.mjs";
import { call, newId, record, requireEnv } from "./lib.mjs";

requireEnv();

export async function run({ usBeneficiaryId, deBeneficiaryId }) {
  // FX: leave x-api-version off (docs/evidence/airwallex-money-path.md). Rate, quote, conversion.
  await call(
    "fx-current-rate",
    "GET",
    "/api/v1/fx/rates/current?buy_currency=EUR&sell_currency=USD&sell_amount=100",
  );
  const quote = await call("fx-quote-create", "POST", "/api/v1/fx/quotes/create", {
    body: { buy_currency: "EUR", sell_currency: "USD", sell_amount: 100, validity: "MIN_15" },
  });
  const conv = await call("fx-conversion-create", "POST", "/api/v1/fx/conversions/create", {
    body: {
      request_id: newId(),
      buy_currency: "EUR",
      sell_currency: "USD",
      sell_amount: 100,
      reason: "payment to supplier",
      term_agreement: true,
    },
  });
  if (conv.body?.conversion_id)
    await call("fx-conversion-fetch", "GET", `/api/v1/fx/conversions/${conv.body.conversion_id}`);
  // conversion from the quote, then the same quote again (the quote says usage MULTI_USE)
  const qid = quote.body?.quote_id;
  if (qid) {
    await call("fx-conversion-from-quote", "POST", "/api/v1/fx/conversions/create", {
      body: {
        request_id: newId(),
        quote_id: qid,
        buy_currency: "EUR",
        sell_currency: "USD",
        sell_amount: 100,
        reason: "payment to supplier",
        term_agreement: true,
      },
    });
    await call("fx-conversion-from-quote-reused", "POST", "/api/v1/fx/conversions/create", {
      body: {
        request_id: newId(),
        quote_id: qid,
        buy_currency: "EUR",
        sell_currency: "USD",
        sell_amount: 100,
        reason: "payment to supplier",
        term_agreement: true,
      },
    });
  }
  await call("fx-conversion-list", "GET", "/api/v1/fx/conversions?page_size=10");

  const b0 = await balances("balances-before-transfers");

  const base = (benId, cur, method, amt) => ({
    request_id: newId(),
    beneficiary_id: benId,
    source_currency: cur,
    transfer_currency: cur,
    source_amount: amt,
    transfer_method: method,
    reason: "professional_business_services",
    reference: "M0-03 spike",
    fee_paid_by: "PAYER",
  });
  const usBody = base(usBeneficiaryId, "USD", "LOCAL", 25);
  const deBody = base(deBeneficiaryId, "EUR", "SWIFT", 30);
  const us = await call("transfer-create-local-usd", "POST", "/api/v1/transfers/create", {
    body: usBody,
  });
  const de = await call("transfer-create-swift-eur", "POST", "/api/v1/transfers/create", {
    body: deBody,
  });
  if (us.status !== 201 || de.status !== 201) {
    console.log(JSON.stringify(us.body).slice(0, 300), JSON.stringify(de.body).slice(0, 300));
    throw new Error("transfer create failed");
  }

  // idempotency: same request_id + same body, then same request_id + changed body
  await call("transfer-reuse-request-id-same-body", "POST", "/api/v1/transfers/create", {
    body: usBody,
  });
  await call("transfer-reuse-request-id-changed-body", "POST", "/api/v1/transfers/create", {
    body: { ...usBody, source_amount: 26 },
  });

  await call("transfer-fetch-local", "GET", `/api/v1/transfers/${us.body.id}`);
  await call("transfer-list", "GET", "/api/v1/transfers?page_size=5");
  await balances("balances-after-transfer-create");
  record("balances-transfer-delta", { before: b0 });
  return { usTransferId: us.body.id, deTransferId: de.body.id };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const { run: r2 } = await import("./02-funding-beneficiaries.mjs");
  console.log(await run(await r2()));
}
