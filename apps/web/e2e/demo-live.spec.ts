import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configFromEnv, createAirwallexClient } from "@carnet/airwallex";
import { expect, type Page, test } from "@playwright/test";
import {
  apiFor,
  envValue,
  expectPayeeHeaders,
  expectPlanScreen,
  nextFriday,
  readPayeePage,
  writeJson,
} from "./demo-support";

// The full demo, storyboard steps 1-9, LIVE (M3-07): the deployed app (E2E_BASE_URL), the real Airwallex
// sandbox and the real model. Nothing is stubbed. It runs only with E2E_MODE=live, only when the live
// resources are free (exclusive AIRWALLEX_SANDBOX and DEPLOY, model spend within MODEL_PER_RUN_CAP_USD),
// and the owner starts it:
//
//   E2E_MODE=live E2E_BASE_URL=https://carnet-web.onrender.com E2E_OWNER_PASSWORD=... \
//     node --env-file=.env node_modules/.bin/playwright test apps/web/e2e/demo-live.spec.ts --reporter=list
//
// Env (names only): E2E_MODE=live, E2E_BASE_URL, E2E_OWNER_PASSWORD, E2E_OWNER_EMAIL (default
// owner@carnet.example), AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY (for the simulator calls the product
// does not make: create the RFI, follow it up, close it), E2E_EVIDENCE_DIR (default docs/evidence/m3:
// one screenshot per step, run.json and airwallex/*.json go there). An empty value counts as unset.
// Clean state: scripts/demo-reset.sh, then a fresh reference prefix per run (RUN below).
// The run record (docs/evidence/m3-run.md) and fixtures/replay/m3 are made from run.json, airwallex/*.json
// and the database export (scripts/demo-export.sh, then scripts/demo-capture-m3.ts); see the template.
const baseUrl = envValue("E2E_BASE_URL");
const ownerPassword = envValue("E2E_OWNER_PASSWORD");
const ownerEmail = envValue("E2E_OWNER_EMAIL") ?? "owner@carnet.example";
test.skip(
  process.env.E2E_MODE !== "live" || !baseUrl || !ownerPassword,
  "live demo: set E2E_MODE=live, E2E_BASE_URL and E2E_OWNER_PASSWORD.",
);
test.describe.configure({ mode: "serial" });

const DATASET = new URL("../../../fixtures/dataset/", import.meta.url);
const OUT = envValue("E2E_EVIDENCE_DIR") ?? join(process.cwd(), "docs", "evidence", "m3");
mkdirSync(join(OUT, "airwallex"), { recursive: true });
const RUN = `M3RUN-${new Date().toISOString().slice(2, 16).replace(/[-:T]/g, "")}`;

// Dataset payees seeded by scripts/demo-reset.sh (packages/db/src/seed/demo-dataset.ts).
const HARBOR = "970431ea-f5c8-56e4-9ce1-5e5a7d12e1a3";
const LAKESIDE = "6b297011-01a1-51c9-8df5-9ab5bfb73049";
const ALTSTADT = "18dfa35f-d0eb-58c9-b90b-15143f9024e0";

interface Step {
  step: number;
  name: string;
  at: string;
  [k: string]: unknown;
}
const record: { run: string; base_url: string; started_at: string; steps: Step[] } = {
  run: RUN,
  base_url: baseUrl ?? "",
  started_at: new Date().toISOString(),
  steps: [],
};
const note = (step: number, name: string, extra: Record<string, unknown> = {}) => {
  record.steps.push({ step, name, at: new Date().toISOString(), ...extra });
  writeJson(OUT, "run.json", record);
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
let airwallexSeq = 0;
/** What the spec itself called on Airwallex (the simulator and reads), as returned; account ids dropped. */
const keep = (name: string, value: unknown) =>
  writeJson(
    join(OUT, "airwallex"),
    `${String(++airwallexSeq).padStart(2, "0")}-${name}.json`,
    JSON.parse(
      JSON.stringify(value, (k, v) => (/account_id|accountId/.test(k) ? "acct_SCRUBBED" : v)),
    ),
  );

let page: Page;
const api = apiFor(() => page);
const docs: Record<string, string> = {};
const payments: Record<string, { id: string; transferId: string | null }> = {};
const obligations: Record<string, string> = {};
let rfiId = "";
let rfiAirwallexId = "";
let questionIds: { title: string; id: string }[] = [];
let client: ReturnType<typeof createAirwallexClient>;
let payeeLinks: { urls: Record<string, string>; held: Record<string, string> } | null = null;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: baseUrl ?? "http://localhost:3000" });
});
test.afterAll(async () => {
  await page.close();
});

/** One dataset PDF; a comment line before `startxref` makes the hash new per run (see M2-09 run note). */
async function uploadDataset(name: string, kind: string): Promise<string> {
  const original = readFileSync(new URL(`${name}.pdf`, DATASET));
  const at = original.lastIndexOf("startxref");
  if (at < 0) throw new Error(`${name}: no startxref`);
  const buf = Buffer.concat([
    original.subarray(0, at),
    Buffer.from(`% carnet live run ${RUN}\n`),
    original.subarray(at),
  ]);
  const res = await page.request.post("/api/v1/documents", {
    multipart: { kind, file: { name: `${name}.pdf`, mimeType: "application/pdf", buffer: buf } },
  });
  expect([200, 201], await res.text()).toContain(res.status());
  return ((await res.json()) as { id: string }).id;
}

interface PlanBlock {
  revision: number;
  inputs_hash: string;
  content_hash: string;
  trigger: { kind: string; payee?: string | null };
  actions: {
    id: string;
    kind: string;
    state: string;
    approvable: boolean;
    bound: Record<string, string> | null;
    auto: { policy_version: number; policy_hash: string } | null;
  }[];
}
const currentPlan = async (): Promise<PlanBlock | null> =>
  (await api.call<{ plan: PlanBlock | null }>("GET", "/api/v1/plans/current")).body.plan;

const NO_PLAN =
  "no plan revision appeared. The deployed worker must load plan inputs and enqueue plan.rerun (BL-01, M3-07 finding); check that wiring is deployed before re-running.";

test("1. goal and plan: owner signs in, states payroll and two suppliers by Friday, confirms criticality, plan revision 1", async () => {
  test.setTimeout(420_000);
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: ownerEmail, password: ownerPassword },
  });
  expect(res.status(), `sign-in ${ownerEmail}: ${await res.text()}`).toBe(200);
  const health = await (await page.request.get("/healthz")).json();

  const files = ["inv-harbor-001", "po-harbor-001", "contract-harbor", "inv-lakeside-001"];
  for (const f of files) {
    const kind = f.startsWith("inv-")
      ? "invoice"
      : f.startsWith("po-")
        ? "purchase_order"
        : "contract";
    docs[f] = await uploadDataset(f, kind);
  }
  for (const f of files) {
    await api.poll(
      `facts of ${f}`,
      async () => {
        const r = await api.call("GET", `/api/v1/documents/${docs[f]}/facts`);
        return r.status === 200 && /"quote_verified":(true|false)/.test(JSON.stringify(r.body));
      },
      200_000,
    );
  }
  // Payments saved (not sent): the obligations below point at them.
  const create = async (counterparty: string, amount: string, ref: string, key: string) => {
    const r = await api.call<{ payment: { id: string } }>(
      "POST",
      "/api/v1/payments",
      {
        amount: { amount, currency: "USD" },
        reference: ref,
        counterparty_id: counterparty,
        send: false,
      },
      { "idempotency-key": `${RUN}-${key}` },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    return r.body.payment.id;
  };
  payments.strong = { id: await create(HARBOR, "4800.00", `${RUN}-001`, "p1"), transferId: null };
  payments.weak = { id: await create(LAKESIDE, "1320.50", `${RUN}-003`, "p3"), transferId: null };

  // The goal, as obligations: payroll (EUR) and two suppliers, due next Friday. The owner confirms each
  // criticality through the only endpoint that sets it; the model's proposal (the Harbor contract) is
  // asked for first and its id is passed so the confirmation records the proposal the owner saw.
  const due = nextFriday(new Date()).toISOString();
  const mk = async (name: string, body: Record<string, unknown>) => {
    const r = await api.call<{ id: string }>("POST", "/api/v1/obligations", {
      due_at: due,
      ...body,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    obligations[name] = r.body.id;
  };
  await mk("payroll", { counterparty_id: ALTSTADT, amount_minor: "250000", currency: "EUR" });
  await mk("harbor", {
    counterparty_id: HARBOR,
    amount_minor: "480000",
    currency: "USD",
    payment_id: payments.strong?.id,
    source_document_id: docs["contract-harbor"],
  });
  await mk("lakeside", {
    counterparty_id: LAKESIDE,
    amount_minor: "132050",
    currency: "USD",
    payment_id: payments.weak?.id,
  });
  const proposed = await api.call(
    "POST",
    `/api/v1/obligations/${obligations.harbor}/criticality/propose`,
    {},
  );
  expect([200, 202], JSON.stringify(proposed.body)).toContain(proposed.status);
  const proposal = await api.poll(
    "criticality proposal for the Harbor contract",
    async () => {
      const r = await api.call<{ latest_proposal: { id: string } | null }>(
        "GET",
        `/api/v1/obligations/${obligations.harbor}`,
      );
      return r.body.latest_proposal?.id ?? null;
    },
    120_000,
  );
  const confirm = async (name: string, criticality: 1 | 2 | 3, proposalId?: string) => {
    const r = await api.call(
      "POST",
      `/api/v1/obligations/${obligations[name]}/criticality/confirm`,
      {
        criticality,
        ...(proposalId ? { proposal_id: proposalId } : {}),
      },
    );
    expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
  };
  await confirm("payroll", 1);
  await confirm("harbor", 2, proposal);
  await confirm("lakeside", 3); // the non-critical bill: the plan may defer it

  const rev1 = await api.poll("plan revision 1", currentPlan, 180_000, 4_000);
  expect(rev1, NO_PLAN).toBeTruthy();
  await expectPlanScreen(page, rev1.revision);
  await shot(page, "01-goal-and-plan-revision-1");
  note(1, "owner signed in; goal stated as obligations; criticality confirmed; plan revision 1", {
    deployed_version: health.version,
    obligations,
    payments: { strong: payments.strong?.id, weak: payments.weak?.id },
    plan_revision: rev1.revision,
    inputs_hash: rev1.inputs_hash,
    content_hash: rev1.content_hash,
  });
});

test("2. evidence flags: the queue shows strength per payment, one not strong", async () => {
  test.setTimeout(180_000);
  const attach = async (pid: string | undefined, names: string[]) => {
    for (const n of names) {
      const r = await api.call("POST", `/api/v1/payments/${pid}/evidence-links`, {
        document_id: docs[n],
      });
      expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    }
  };
  await attach(payments.strong?.id, ["inv-harbor-001", "po-harbor-001", "contract-harbor"]);
  await attach(payments.weak?.id, ["inv-lakeside-001"]);
  const flagOf = async (pid: string | undefined) => {
    const r = await api.call<Record<string, unknown>>(
      "GET",
      `/api/v1/payments/${pid}/evidence-check`,
    );
    return (r.body.flag ?? (r.body.check as { flag?: string } | undefined)?.flag) as string;
  };
  const strong = await api.poll(
    "strong payment flag",
    async () => ((await flagOf(payments.strong?.id)) ? await flagOf(payments.strong?.id) : null),
    90_000,
  );
  const weak = await flagOf(payments.weak?.id);
  expect(strong).toBe("strong");
  expect(weak).not.toBe("strong");
  await page.goto("/payments");
  await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  await shot(page, "02-queue-evidence-flags");
  note(2, "evidence flags computed", { flag_harbor: strong, flag_lakeside: weak });
});

test("3. payments: both cleared, both sent as real sandbox transfers", async () => {
  test.setTimeout(240_000);
  const refused = await api.call("POST", `/api/v1/payments/${payments.weak?.id}/send`, {});
  expect(refused.status).toBe(412);
  const ok1 = await api.call("POST", `/api/v1/payments/${payments.strong?.id}/send`, {});
  expect(ok1.status, JSON.stringify(ok1.body)).toBe(200);
  const ok2 = await api.call("POST", `/api/v1/payments/${payments.weak?.id}/send`, {
    evidence_ack: { acknowledged: true },
  });
  expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
  for (const key of ["strong", "weak"] as const) {
    const p = payments[key];
    if (!p) throw new Error("payment missing");
    const d = await api.poll(
      `${key} transfer created`,
      async () => {
        const r = await api.call<{ payment: { transfer_id: string | null } }>(
          "GET",
          `/api/v1/payments/${p.id}`,
        );
        return r.body.payment.transfer_id ? r.body.payment : null;
      },
      150_000,
    );
    p.transferId = d.transfer_id;
  }
  await page.goto("/payments");
  await shot(page, "03-payments-sent");
  note(3, "payments sent (real sandbox transfers)", {
    weak_send_without_ack_status: refused.status,
    transfers: { strong: payments.strong?.transferId, weak: payments.weak?.transferId },
  });
});

test("4. hold: a real Transaction RFI on the sent transfer; webhook verified; payment held; plan re-runs to revision 2", async () => {
  test.setTimeout(420_000);
  client = createAirwallexClient(configFromEnv(process.env));
  const transferId = payments.strong?.transferId;
  if (!transferId) throw new Error("no transfer");
  const before = await currentPlan();
  // Money status the RFI must not touch.
  const statusOf = async () =>
    (
      await api.call<{ payment: { transfer_status: string | null } }>(
        "GET",
        `/api/v1/payments/${payments.strong?.id}`,
      )
    ).body.payment.transfer_status;
  // A TRANSFER source must already be PROCESSING (M0-04); the simulator moves it there.
  try {
    keep(
      "transition-processing",
      await client.simulator.transitionTransfer(transferId, "PROCESSING"),
    );
  } catch (error) {
    const now = await client.getTransfer(transferId);
    if (String(now.status) !== "PROCESSING") throw error;
  }
  const set = JSON.parse(
    readFileSync(new URL("rfi-sets/rfi-set-harbor.json", DATASET), "utf8"),
  ) as {
    rounds: {
      questions: { title: { en: string }; description: { en: string }; answer: { type: string } }[];
    }[];
  };
  const questions = (set.rounds[0]?.questions ?? []).map((q) => ({
    answerType: q.answer.type as "TEXT" | "ATTACHMENT",
    title: q.title.en,
    description: q.description.en,
    sources: [{ id: transferId, type: "TRANSFER" as const }],
  }));
  // Delivery note and remittance advice: the RFI's attachment questions need them on file.
  for (const f of ["dn-harbor-001", "remit-brightline-001"])
    docs[f] = await uploadDataset(f, "other");
  const tCreate = Date.now();
  const rfi = await client.simulator.createRfi({ type: "TRANSACTION", questions });
  keep("rfi-create", rfi);
  rfiAirwallexId = rfi.id;
  questionIds = (rfi.activeRequest?.questions ?? []).map((q) => ({
    title: q.title.en ?? "",
    id: q.id,
  }));
  const found = await api.poll(
    "the RFI reaches Carnet through the signed webhook",
    async () => {
      const r = await api.call<{ items: Record<string, unknown>[] }>("GET", "/api/v1/rfis");
      return r.body.items?.find((i) => JSON.stringify(i).includes(rfiAirwallexId)) ?? null;
    },
    240_000,
  );
  rfiId = String((found as { id: string }).id);
  const tSeen = Date.now();
  await api.poll(
    "the payment shows as held",
    async () => {
      const r = await api.call<{ payment: { held: boolean } }>(
        "GET",
        `/api/v1/payments/${payments.strong?.id}`,
      );
      return r.body.payment.held ? true : null;
    },
    120_000,
  );
  const during = await statusOf();
  expect(during).not.toBe("SENT");
  expect(during).not.toBe("PAID");
  const rev2 = await api.poll(
    "plan revision 2 after the hold",
    async () => {
      const p = await currentPlan();
      return p && p.revision > (before?.revision ?? 0) ? p : null;
    },
    240_000,
    4_000,
  );
  expect(rev2.trigger.kind).toBe("held");
  // Payee links, read now: held and PROCESSING is the only time the opt-in wording can show.
  const urls: Record<string, string> = {};
  for (const level of ["GENERIC", "DELAYED_FOR_VERIFICATION"] as const) {
    const r = await api.call<{ path: string | null }>(
      "POST",
      `/api/v1/payments/${payments.strong?.id}/payee-links`,
      { disclosure_level: level },
      { "idempotency-key": `${RUN}-payee-${level.toLowerCase()}` },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    urls[level] = `${baseUrl}${r.body.path}`;
  }
  const heldReads: Record<string, string> = {};
  for (const [level, url] of Object.entries(urls)) {
    const read = await readPayeePage(page, url);
    expect(read.status).toBe(200);
    expectPayeeHeaders(read.headers);
    for (const secret of ["4,800", "4800", "Harbor", "USD", "Carnet", RUN]) {
      expect(read.text, `${level} page leaks ${secret}`).not.toContain(secret);
    }
    heldReads[level] = read.text.replace(/\s+/g, " ");
    if (level === "GENERIC") expect(read.text).not.toContain("Delayed for verification");
    else expect(read.text).toContain("Delayed for verification");
    const viewer = await page.context().browser()?.newContext();
    if (!viewer) throw new Error("no browser");
    const vp = await viewer.newPage();
    await vp.goto(url);
    await vp.screenshot({
      path: join(OUT, `09b-payee-page-${level.toLowerCase()}-while-held.png`),
    });
    await viewer.close();
  }
  payeeLinks = { urls, held: heldReads };
  await expectPlanScreen(page, rev2.revision);
  await page.goto(`/payments/${payments.strong?.id}`);
  await shot(page, "04-hold-payment-held-plan-revision-2");
  note(4, "simulated RFI created, webhook received, payment held, plan re-ran", {
    rfi_airwallex_id: rfiAirwallexId,
    rfi_id: rfiId,
    creation_path:
      "SandboxSimulator port, POST /api/v1/simulation/rfis/create (ADR 0018); not injected",
    ms_create_to_visible_in_carnet: tSeen - tCreate,
    transfer_status_while_held: during,
    plan_revision: rev2.revision,
    inputs_hash: rev2.inputs_hash,
    content_hash: rev2.content_hash,
    previous_inputs_hash: before?.inputs_hash,
    trigger: rev2.trigger,
  });
});

type HoldView = {
  rfi?: { state: string; round?: number };
  draft: { id: string; state: string } | null;
  attempt?: { status: string; request_id: string } | null;
  approval?: { status: string; hash?: string } | null;
  questions: {
    id: string;
    title: string;
    answer: {
      status: string;
      text: string;
      citations: { fact_version_id: string }[];
      documents: { id: string }[];
    } | null;
  }[];
};
const hold = async () => (await api.call<HoldView>("GET", `/api/v1/rfis/${rfiId}/hold`)).body;

/** The owner's own statements for questions the live model declines (never invented by the product). */
const OWNER_TEXT: Record<string, string> = {
  "Relationship with the counterparty":
    "Harbor Print Co. is our regular printing supplier. We buy brochures and posters from them under a written supply agreement, and this payment settles one of their invoices.",
  "Purpose of payment":
    "This payment is for the printing of marketing brochures and posters that Harbor Print Co. produced for our clients, under our supply agreement with them.",
};

test("5. drafts and approval: cited drafts, source snippets, one bound approval, submit", async () => {
  test.setTimeout(600_000);
  const tStart = Date.now();
  let ready = await api.poll(
    "the model's draft is finished",
    async () => {
      const v = await hold();
      return v.draft?.state === "DRAFT_READY" || v.rfi?.state === "NEEDS_OWNER" ? v : null;
    },
    300_000,
    4_000,
  );
  const draftedAt = Date.now();
  if (ready.rfi?.state === "NEEDS_OWNER") {
    const declined = ready.questions.filter((q) => q.answer?.status === "NEEDS_OWNER");
    const unexpected = declined.filter((q) => !OWNER_TEXT[q.title]);
    if (unexpected.length > 0 || !ready.draft) {
      throw new Error(
        `unexpected declined question(s): ${unexpected.map((q) => q.title).join(", ")}`,
      );
    }
    const res = await api.call(
      "POST",
      `/api/v1/rfis/${rfiId}/drafts`,
      {
        parent_draft_id: ready.draft.id,
        answers: ready.questions.map((q) => {
          const owner = declined.some((d) => d.id === q.id) ? OWNER_TEXT[q.title] : undefined;
          return owner
            ? {
                question_id: q.id,
                text: owner,
                document_ids: [],
                fact_version_ids: [],
                owner_authored: true,
              }
            : {
                question_id: q.id,
                text: q.answer?.text ?? "",
                document_ids: (q.answer?.documents ?? []).map((d) => d.id),
                fact_version_ids: (q.answer?.citations ?? []).map((c) => c.fact_version_id),
                owner_authored: q.answer?.status === "OWNER_AUTHORED",
              };
        }),
      },
      { "idempotency-key": `${RUN}-owner-draft` },
    );
    expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
    ready = await api.poll(
      "DRAFT_READY after the owner's answer",
      async () => ((await hold()).draft?.state === "DRAFT_READY" ? await hold() : null),
      60_000,
      2_000,
    );
    note(5, "the live model declined question(s); the owner wrote them", {
      owner_authored_questions: declined.map((q) => q.title),
    });
  }
  await page.goto(`/rfis/${rfiId}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
  await expect(page.getByTestId("source-snippet").first()).toContainText("Quote verified");
  await page.getByTestId("approve-button").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  const tApprove = Date.now();
  await dialog
    .getByRole("button", { name: /approve|send/i })
    .last()
    .click();
  const done = await api.poll(
    "RFI ANSWERED with a CONFIRMED attempt",
    async () => {
      const v = await hold();
      return v.rfi?.state === "ANSWERED" && v.attempt?.status === "CONFIRMED" ? v : null;
    },
    240_000,
    3_000,
  );
  await page.reload();
  await shot(page, "05-draft-approved-answered");
  note(5, "approved, responded, answered", {
    ms_event_to_draft: draftedAt - tStart,
    ms_approval_to_answered: Date.now() - tApprove,
    attempt: done.attempt,
    approval_status: done.approval?.status,
    approval_hash_round_1: done.approval?.hash,
  });
});

test("6. plan revised: conversion auto-executes under policy, payout approved on the plan screen, bill deferred", async () => {
  test.setTimeout(420_000);
  const current = await api.poll(
    "a plan with a conversion executed",
    async () => {
      const p = await currentPlan();
      const conv = p?.actions.find((a) => a.kind === "convert");
      return p && conv && ["EXECUTING", "DONE"].includes(conv.state) ? p : null;
    },
    300_000,
    4_000,
  );
  const conversion = current.actions.find((a) => a.kind === "convert");
  // Auto-executed under policy: an AutoApproval record with the policy version and hash, no owner action.
  expect(conversion?.auto, "the conversion carries no AutoApproval record").toBeTruthy();
  await page.goto("/plans/current");
  await expect(page.getByTestId("plan-screen")).toBeVisible();
  await shot(page, "06a-plan-conversion-auto-executed");

  const payout = page.locator('[data-testid="action-card"][data-kind="payout"]');
  await expect(payout.getByTestId("approve-button")).toBeEnabled();
  await payout.getByTestId("approve-button").click();
  await expect(page.getByTestId("plan-approve-dialog")).toBeVisible();
  await page.getByTestId("plan-approve-confirm").click();
  const after = await api.poll(
    "payout and conversion DONE",
    async () => {
      const p = await currentPlan();
      const conv = p?.actions.find((a) => a.kind === "convert");
      const pay = p?.actions.find((a) => a.kind === "payout");
      return p && conv?.state === "DONE" && pay?.state === "DONE" ? p : null;
    },
    300_000,
    4_000,
  );
  const deferred = after.actions.filter((a) => a.kind === "defer");
  expect(deferred.length, "no non-critical bill was deferred").toBeGreaterThan(0);
  await page.reload();
  await shot(page, "06b-plan-payout-executed-bill-deferred");
  note(6, "revision executed: conversion under policy, payout approved, bill deferred", {
    plan_revision: after.revision,
    inputs_hash: after.inputs_hash,
    content_hash: after.content_hash,
    conversion_auto: conversion?.auto,
    action_states: after.actions.map((a) => ({ id: a.id, kind: a.kind, state: a.state })),
  });
});

test("7. transfer outcome on its own status: the held transfer reaches SENT and PAID; the RFI answer changed nothing", async () => {
  test.setTimeout(300_000);
  const sp = payments.strong;
  if (!sp?.transferId) throw new Error("no strong payment");
  const statusOf = async () =>
    (
      await api.call<{ payment: { transfer_status: string | null } }>(
        "GET",
        `/api/v1/payments/${sp.id}`,
      )
    ).body.payment.transfer_status;
  const whileAnswered = await statusOf();
  expect(whileAnswered).not.toBe("SENT");
  expect(whileAnswered).not.toBe("PAID");
  for (const next of ["SENT", "PAID"] as const) {
    const r = await api.call("POST", `/api/v1/payments/${sp.id}/simulate`, { next_status: next });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await api.poll(
      `transfer ${next}`,
      async () => ((await statusOf()) === next ? true : null),
      120_000,
    );
  }
  keep("transfer-final", await client.getTransfer(sp.transferId));
  await page.goto(`/payments/${sp.id}`);
  await shot(page, "07-transfer-paid-own-status");
  note(7, "transfer reached SENT then PAID on its own status", {
    transfer_status_while_rfi_answered: whileAnswered,
    final_transfer_status: await statusOf(),
    transfer_id: sp.transferId,
  });
});

test("8. follow-up round: a real follow_up reopens a question; round 2 reuses an approved answer in one click and drafts the new one", async () => {
  test.setTimeout(600_000);
  const reopen = questionIds.find((q) => q.title === "Purpose of payment") ?? questionIds[0];
  if (!reopen) throw new Error("no question id recorded for the RFI");
  const roundBefore = (await hold()).rfi?.round ?? 1;
  const followUp = await client.simulator.followUpRfi(rfiAirwallexId, {
    reopen: [reopen.id],
    append: [
      {
        answerType: "TEXT",
        title: "Expected delivery date",
        description: "When are the goods covered by this payment expected to be delivered?",
        sources: [{ id: String(payments.strong?.transferId), type: "TRANSFER" }],
      },
    ],
  });
  keep("rfi-follow-up", followUp);
  await api.poll(
    "round 2 in Carnet",
    async () => (((await hold()).rfi?.round ?? 1) > roundBefore ? true : null),
    240_000,
  );
  // One click: reuse the approved answer. No model call is made for it (checked in the export: no
  // rfi.draft step for the reused question).
  const reuse = await api.call<{ reused: boolean; draft: { id: string } | null }>(
    "POST",
    `/api/v1/rfis/${rfiId}/reuse`,
    {},
  );
  expect(reuse.status, JSON.stringify(reuse.body)).toBe(200);
  expect(reuse.body.reused).toBe(true);
  const ready = await api.poll(
    "round 2 draft ready",
    async () => {
      const v = await hold();
      return v.draft?.state === "DRAFT_READY" ? v : null;
    },
    300_000,
    4_000,
  );
  await page.goto(`/rfis/${rfiId}`);
  await expect(page.getByTestId("follow-up-panel")).toBeVisible();
  await expect(page.getByTestId("same-as-approved").first()).toContainText("Same as approved on");
  await shot(page, "08-follow-up-round-2-reused");
  const applyAll = page.getByTestId("apply-reused");
  const oneClick = (await applyAll.count()) > 0;
  if (oneClick) await applyAll.click();
  else {
    // The appended question is new, so the whole round is approved in the dialog, as in round 1.
    await page.getByTestId("approve-button").click();
    const dialog = page.getByTestId("approve-dialog");
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("button", { name: /approve|send/i })
      .last()
      .click();
  }
  const answered = await api.poll(
    "round 2 answered",
    async () => {
      const v = await hold();
      return v.rfi?.state === "ANSWERED" && v.attempt?.status === "CONFIRMED" ? v : null;
    },
    240_000,
    3_000,
  );
  note(8, "follow-up round 2: one answer reused, one drafted", {
    reopened_question: reopen.title,
    appended_question: "Expected delivery date",
    applied_with_one_click: oneClick,
    draft_id: ready.draft?.id,
    attempt: answered.attempt,
    approval_hash_round_2: answered.approval?.hash,
    note: "zero model calls for the reused answer: confirm in the export (agent_steps) before claiming",
  });
});

test("9. payee page: GENERIC wording, the opt-in wording only while held, neither once the transfer is paid", async () => {
  test.setTimeout(240_000);
  // The opt-in wording needs a held payment whose transfer is still PROCESSING (payeeStatus: SENT and PAID
  // win), so the held reads were taken in step 4. Here the RFI is closed and the transfer is PAID.
  if (!payeeLinks) throw new Error("no payee links: step 4 did not run");
  keep("rfi-close", await client.simulator.closeRfi(rfiAirwallexId));
  await api.poll(
    "RFI closed in Carnet",
    async () => ((await hold()).rfi?.state === "CLOSED" ? true : null),
    180_000,
  );
  const viewer = await page.context().browser()?.newContext();
  if (!viewer) throw new Error("no browser");
  const vp = await viewer.newPage();
  const texts: Record<string, string> = {};
  for (const [level, url] of Object.entries(payeeLinks.urls)) {
    const res = await vp.goto(url);
    expect(res?.status()).toBe(200);
    expectPayeeHeaders(res?.headers() ?? {});
    texts[level] = (await vp.locator("body").innerText()).replace(/\s+/g, " ");
    expect(texts[level]).not.toContain("Delayed for verification");
    await vp.screenshot({
      path: join(OUT, `09c-payee-page-${level.toLowerCase()}-after-paid.png`),
    });
  }
  await viewer.close();
  await page.goto(`/payments/${payments.strong?.id}`);
  await shot(page, "09a-payee-links-owner-panel");
  note(9, "payee page wording", {
    held_reads: payeeLinks.held,
    after_paid_reads: texts,
    tokens: "not recorded (they are secrets of the link)",
  });
});
