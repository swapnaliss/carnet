// M3-03 live proof (ticket scope item 8). SKIPPED unless M3_LIVE=1; it holds the exclusive
// AIRWALLEX_SANDBOX and uses sandbox keys from the environment (never production: configFromEnv refuses a
// non-sandbox host). It needs the same local Postgres as the other db tests (DATABASE_URL and
// DATABASE_MIGRATION_URL).
//
//   M3_LIVE=1 npx vitest run packages/db/src/executors/live.test.ts
//
// What it does, against the real sandbox:
//   1. one real FX conversion (USD to EUR, USD 1.00) auto-executed under a recorded policy: an
//      auto_approvals row with the policy version and hash, an attempt CONFIRMED;
//   2. one real payout (USD 1.00, LOCAL) executed after a real bound approval: approval CONSUMED, attempt
//      CONFIRMED, the transfer id from the sandbox.
// It records every sandbox request and response (login excluded; the Authorization header is never
// stored) under fixtures/airwallex/m3/, and writes docs/evidence/m3-03-live.md (ids, statuses, policy version
// and hash, attempt rows; no secrets). This file was written without running it (the sandbox was held by
// another ticket); the first live run is the manager's.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newPaymentId } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import { configFromEnv, createAirwallexClient, type FetchLike } from "../../../airwallex/src/index";
import {
  approvePayout,
  convertAction,
  seedWorld,
  storePlan,
  type World,
} from "../../test/executor-world";
import { useTestDatabase } from "../../test/harness";
import {
  createCounterparty,
  createPayment,
  getApproval,
  getAutoApprovalForAction,
  getLatestPolicy,
  getStoredAction,
  listAttemptsForRefs,
  updateCounterparty,
} from "../repos/index";
import { type ExecutionGateway, executeAutoConversion, executePayout } from "./index";

const LIVE = process.env.M3_LIVE === "1";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURES = resolve(ROOT, "fixtures/airwallex/m3");
const EVIDENCE = resolve(ROOT, "docs/evidence/m3-03-live.md");

interface Recorded {
  method: string;
  path: string;
  request?: unknown;
  response: { status: number; headers: Record<string, string>; body: unknown };
}

/** A fetch that records each call (except the login) as a fixture file's content. */
function recordingFetch(into: Recorded[]): FetchLike {
  return async (input, init) => {
    const res = await globalThis.fetch(input, init);
    const url = new URL(input);
    if (url.pathname.includes("/authentication/")) return res;
    const text = await res.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the text
    }
    into.push({
      method: init.method ?? "GET",
      path: `${url.pathname}${url.search}`,
      ...(typeof init.body === "string" ? { request: JSON.parse(init.body) as unknown } : {}),
      response: {
        status: res.status,
        headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
        body,
      },
    });
    return res;
  };
}

const DEMO_BENEFICIARY = {
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
} as const;

describe.skipIf(!LIVE)("M3-03 live proof (sandbox)", () => {
  const database = useTestDatabase({ prefix: "m3live" });

  it("auto-executes one real conversion under policy and one real payout after a bound approval", async () => {
    const recorded: Recorded[] = [];
    const client = createAirwallexClient({
      ...configFromEnv(process.env),
      fetch: recordingFetch(recorded),
    });
    const w: World = await seedWorld(database().app.db);
    const gateway = client as unknown as ExecutionGateway;
    const deps = { db: w.db, gateway, swiftPayoutFeeMinor: () => 0n };

    // 1. A conversion the policy allows: USD 1.00 (limit USD 10.00 in the test policy).
    const { actionIds } = await storePlan(w, [
      convertAction(1, {
        sell_minor: "100",
        buy_minor: "88",
        rate: "0.8840",
        rate_low: "0.8",
        rate_high: "0.95",
      }),
    ]);
    const actionId = actionIds[0] as string;
    const conversion = await executeAutoConversion(deps, w.businessId, actionId);
    expect(conversion.outcome).toBe("confirmed");
    const policy = await getLatestPolicy(w.ctx);
    const auto = await getAutoApprovalForAction(w.ctx, actionId);
    const [convAttempt] = await listAttemptsForRefs(w.ctx, "conversion", [actionId]);
    expect(auto).toMatchObject({ policyVersion: policy?.version, policyHash: policy?.hash });
    expect(convAttempt?.status).toBe("CONFIRMED");

    // 2. A payout executed after a real bound approval.
    const beneficiary = await client.createBeneficiary({
      requestId: crypto.randomUUID() as never,
      nickname: `carnet-m3-${Date.now()}`,
      beneficiary: DEMO_BENEFICIARY as never,
      transferMethods: ["LOCAL"],
    });
    const cp = await createCounterparty(w.ctx, {
      name: "Northwind Test Supplies LLC",
      country: "US",
    });
    await updateCounterparty(w.ctx, cp.id, { beneficiaryId: beneficiary.id });
    const payment = await createPayment(w.ctx, {
      id: newPaymentId(),
      counterpartyId: cp.id,
      amount: { minor: 100n, currency: "USD" },
      sourceCurrency: "USD",
      method: "LOCAL",
      reference: "M3-03 live proof",
    });
    const approval = await approvePayout(w, client as never, payment.id);
    const payout = await executePayout(deps, w.businessId, approval);
    expect(payout.outcome).toBe("confirmed");
    const [transferAttempt] = await listAttemptsForRefs(w.ctx, "transfer", [payment.id]);
    const consumed = await getApproval(w.ctx, approval.approvalId);
    expect(consumed?.status).toBe("CONSUMED");
    expect(transferAttempt?.status).toBe("CONFIRMED");
    expect((await getStoredAction(w.ctx, actionId))?.state).toBe("DONE");

    // Fixtures and evidence (no secrets: ids, statuses, hashes, attempt rows).
    mkdirSync(FIXTURES, { recursive: true });
    recorded.forEach((r, i) => {
      const name = `${String(i + 1).padStart(2, "0")}-${r.method.toLowerCase()}-${r.path
        .split("?")[0]
        ?.replace(/[^a-z0-9]+/gi, "-")
        .replace(/^-|-$/g, "")}.json`;
      writeFileSync(resolve(FIXTURES, name), `${JSON.stringify(r, null, 2)}\n`);
    });
    const conv = conversion.outcome === "confirmed" ? conversion.conversion : null;
    const transfer =
      payout.outcome === "confirmed" ? (payout.transfer as { id: string; status: string }) : null;
    mkdirSync(dirname(EVIDENCE), { recursive: true });
    writeFileSync(
      EVIDENCE,
      [
        "# M3-03 live proof (Airwallex sandbox)",
        "",
        `Recorded ${new Date().toISOString()} against the sandbox. Sandbox keys only; no secret appears here.`,
        "",
        "## Conversion under policy",
        `- plan action: ${actionId}`,
        `- policy version ${policy?.version}, hash ${policy?.hash}`,
        `- auto_approvals row: ${auto?.id}, amount ${auto?.amountMinor} ${auto?.currency}, daily total after ${auto?.dailyTotalAfterMinor}`,
        `- attempt ${convAttempt?.id}: request_id ${convAttempt?.requestId}, status ${convAttempt?.status}`,
        `- Airwallex conversion id ${conv?.conversionId}, status ${conv?.status}`,
        "",
        "## Payout after a bound approval",
        `- payment: ${payment.id}, beneficiary ${beneficiary.id}`,
        `- approval ${approval.approvalId}: hash ${approval.expectedHash}, status ${consumed?.status}`,
        `- attempt ${transferAttempt?.id}: request_id ${transferAttempt?.requestId}, status ${transferAttempt?.status}`,
        `- Airwallex transfer id ${transfer?.id}, status ${transfer?.status}`,
        "",
        "## Fixtures",
        `${recorded.length} calls recorded under fixtures/airwallex/m3/ (login excluded).`,
        "",
        "## Differences from the recorded M0 behaviour",
        "Fill in after the run: anything the sandbox did differently from docs/evidence/airwallex-rfi-contract.md. Mark unverified items as such.",
        "",
      ].join("\n"),
    );
  });
});
