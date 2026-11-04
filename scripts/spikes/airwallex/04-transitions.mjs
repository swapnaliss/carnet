import { call, must, newId, record, requireEnv, sleep } from "./lib.mjs";

requireEnv();

// Documented at https://www.airwallex.com/docs/api/simulation/transfers (fetched 2026-11-03).
export const FAILURE_TYPES = [
  "ACCOUNT_CLOSED",
  "ACCOUNT_CURRENCY_MISMATCH",
  "ACCOUNT_INACTIVE_OR_DORMANT",
  "ACCOUNT_UNDER_RESTRICTION",
  "BENEFICIARY_BANK_RETURNED",
  "BENEFICIARY_NAME_MISMATCH",
  "BENEFICIARY_REQUESTED",
  "CARD_ISSUER_ERROR",
  "CHANNEL_POLICY",
  "CHANNEL_TIMEOUT",
  "CLIENT_REQUESTED",
  "DUPLICATION_RETURN",
  "EXCEEDED_TRANSACTION_AMOUNT_OR_LIMIT",
  "INBOUND_2B_CARD_NOT_SUPPORTED",
  "INBOUND_BENFICIARY_VALIDATION_ERROR",
  "INBOUND_COMPANY_REGISTRATION_NUMBER_ERROR",
  "INBOUND_ORDER_ERROR",
  "INSUFFICIENT_FUNDS",
  "INVALID_ACCOUNT_NAME_OR_NUMBER",
  "INVALID_BANK_INFORMATION",
  "INVALID_BANK_OR_BRANCH_CODE",
  "INVALID_BENEFICIARY_DETAILS",
  "INVALID_CORRESPONDENT_BANK_INFORMATION",
  "INVALID_PAYMENT_PURPOSE",
  "INVALID_SPECIAL_CHARACTER",
  "INVALID_SWIFT_BIC_CODE",
  "OTHER",
  "RECALL_REQUESTED",
  "SYSTEM_ERROR",
  "TM_SUSPENDED",
  "TRANSACTION_AMOUNT_NOT_COVERING_FEE",
  "UNABLE_TO_APPLY",
];

// 4 Nov 2026: fee_paid_by PAYER on USD LOCAL now returns 400 fee_unknown; omitting it works (BL-01).
export async function newTransfer(name, benId, cur, method, amount) {
  const r = await call(name, "POST", "/api/v1/transfers/create", {
    body: {
      request_id: newId(),
      beneficiary_id: benId,
      source_currency: cur,
      transfer_currency: cur,
      source_amount: amount,
      transfer_method: method,
      reason: "professional_business_services",
      reference: "M0-03 spike",
    },
  });
  return must(r);
}
export const transition = (name, id, body) =>
  call(name, "POST", `/api/v1/simulation/transfers/${id}/transition`, { body });
const fetchStatus = async (id) => (await call("tmp-fetch", "GET", `/api/v1/transfers/${id}`)).body;

async function waitFor(id, want, tries = 15) {
  let cur;
  for (let i = 0; i < tries; i++) {
    cur = (await fetchStatus(id)).status;
    if (cur === want) return cur;
    await sleep(1000);
  }
  return cur;
}

export async function run({ usBeneficiaryId, deBeneficiaryId }) {
  // Happy path for both routes. A new transfer starts SCHEDULED and moves to PROCESSING by itself;
  // asking the simulator for PROCESSING is an invalid transition (recorded once, then not repeated).
  const paths = {};
  for (const [label, ben, cur, method] of [
    ["local-usd", usBeneficiaryId, "USD", "LOCAL"],
    ["swift-eur", deBeneficiaryId, "EUR", "SWIFT"],
  ]) {
    const t = await newTransfer(`transfer-create-${label}-for-transitions`, ben, cur, method, 12);
    const seen = [`create:${t.status}`];
    seen.push(`auto:${await waitFor(t.id, "PROCESSING")}`);
    if (label === "local-usd")
      await transition("transition-processing-invalid", t.id, { next_status: "PROCESSING" });
    for (const s of ["SENT", "PAID"]) {
      const r = await transition(`transition-${label}-${s.toLowerCase()}`, t.id, {
        next_status: s,
      });
      seen.push(r.status === 200 ? `${s}:${r.body.status}` : `${s}:HTTP ${r.status}`);
    }
    await call(`transfer-fetch-${label}-paid`, "GET", `/api/v1/transfers/${t.id}`);
    paths[label] = seen;
  }
  record("transition-happy-paths", paths);

  // PAID can still fail
  const t2 = await newTransfer(
    "transfer-create-paid-then-fail",
    usBeneficiaryId,
    "USD",
    "LOCAL",
    11,
  );
  await waitFor(t2.id, "PROCESSING");
  for (const s of ["SENT", "PAID"])
    await transition(`transition-paidfail-${s.toLowerCase()}`, t2.id, { next_status: s });
  const pf = await transition("transition-paid-to-failed", t2.id, {
    next_status: "FAILED",
    failure_type: "BENEFICIARY_BANK_RETURNED",
  });
  await call("transfer-fetch-paid-then-failed", "GET", `/api/v1/transfers/${t2.id}`);
  // CANCELLED and OVERDUE from PROCESSING
  const t3 = await newTransfer(
    "transfer-create-for-cancelled",
    usBeneficiaryId,
    "USD",
    "LOCAL",
    11,
  );
  await waitFor(t3.id, "PROCESSING");
  const cx = await transition("transition-cancelled", t3.id, { next_status: "CANCELLED" });
  await call("transfer-fetch-cancelled", "GET", `/api/v1/transfers/${t3.id}`);
  const t4 = await newTransfer("transfer-create-for-overdue", usBeneficiaryId, "USD", "LOCAL", 11);
  await waitFor(t4.id, "PROCESSING");
  const od = await transition("transition-overdue", t4.id, { next_status: "OVERDUE" });
  await call("transfer-fetch-overdue", "GET", `/api/v1/transfers/${t4.id}`);

  // every documented failure_type, one transfer each: PROCESSING -> SENT -> FAILED(type)
  const failures = {};
  let example;
  for (const ft of FAILURE_TYPES) {
    const t = await newTransfer(`tmp-create-${ft}`, usBeneficiaryId, "USD", "LOCAL", 10);
    await waitFor(t.id, "PROCESSING");
    await transition(`tmp-sent-${ft}`, t.id, { next_status: "SENT" });
    const f = await transition(`tmp-failed-${ft}`, t.id, {
      next_status: "FAILED",
      failure_type: ft,
    });
    const got = await fetchStatus(t.id);
    failures[ft] = {
      http: f.status,
      simulatorStatus: f.body?.status,
      simulatorFailureType: f.body?.failure_type,
      simulatorFailureReason: f.body?.failure_reason,
      fetchedStatus: got.status,
      fetchedFailure: got.failure,
      transferId: t.id,
    };
    example ??= t.id;
  }
  record("transition-failure-types", failures);
  await call("transfer-fetch-failed-example", "GET", `/api/v1/transfers/${example}`);
  record("transition-paid-cancelled-overdue", {
    paidToFailed: { http: pf.status, status: pf.body?.status },
    cancelled: { http: cx.status, status: cx.body?.status },
    overdue: { http: od.status, status: od.body?.status },
  });
  return { failures };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const a = await import("./02-funding-beneficiaries.mjs");
  const out = await run(await a.run());
  console.log(
    Object.entries(out.failures)
      .map(([k, v]) => `${k}:${v.http}/${v.simulatorStatus}->${v.fetchedStatus}`)
      .join("\n"),
  );
}
