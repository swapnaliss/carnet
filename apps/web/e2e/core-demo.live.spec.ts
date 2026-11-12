import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFromEnv, createAirwallexClient } from "@carnet/airwallex";
import { expect, type Page, test } from "@playwright/test";

// The core demo, storyboard steps 1-8, LIVE (M2-09): the deployed app (E2E_BASE_URL), the real Airwallex
// sandbox and the real model. Nothing is stubbed. It runs only when the live resources are free (the
// manager holds AIRWALLEX_SANDBOX, DEPLOY and ANTHROPIC for the run; see .prp/SESSIONS.md) and only
// when asked for: without E2E_BASE_URL and E2E_OWNER_PASSWORD it is skipped loudly.
//
//   node --env-file=.env node_modules/.bin/playwright test apps/web/e2e/core-demo.live.spec.ts \
//     (with E2E_BASE_URL=https://carnet-web.onrender.com and E2E_OWNER_PASSWORD in the environment)
//
// Env (names only): E2E_BASE_URL, E2E_OWNER_PASSWORD, E2E_OWNER_EMAIL (default owner@carnet.example),
// AIRWALLEX_CLIENT_ID / AIRWALLEX_API_KEY (the sandbox, for the simulator calls the product itself does
// not make: creating and closing the simulated RFI), E2E_EVIDENCE_DIR (screenshots and run.json go
// there; default $TMPDIR/m2-run). Clean state: scripts/demo-reset.sh, then a fresh reference prefix per
// run (RUN below), so nothing from an earlier run is reused.
// The run record (docs/evidence/m2-run.md) is written from run.json and the database export
// (scripts/demo-export.sh); this spec records only what a client can observe.
const ownerPassword = process.env.E2E_OWNER_PASSWORD;
const ownerEmail = process.env.E2E_OWNER_EMAIL || "owner@carnet.example";
const live = process.env.E2E_MODE !== "replay" && Boolean(process.env.E2E_BASE_URL);
test.skip(
  !live || !ownerPassword,
  "live core demo: set E2E_BASE_URL and E2E_OWNER_PASSWORD (and not E2E_MODE=replay).",
);
test.describe.configure({ mode: "serial" });

const DATASET = new URL("../../../fixtures/dataset/", import.meta.url);
const OUT = process.env.E2E_EVIDENCE_DIR || join(process.env.TMPDIR ?? "/tmp", "m2-run");
mkdirSync(OUT, { recursive: true });
const RUN = `M2RUN-${new Date().toISOString().slice(2, 16).replace(/[-:T]/g, "")}`;

// The dataset payees seeded by scripts/demo-reset.sh (packages/db/src/seed/demo-dataset.ts).
const HARBOR = "970431ea-f5c8-56e4-9ce1-5e5a7d12e1a3";
const LAKESIDE = "6b297011-01a1-51c9-8df5-9ab5bfb73049";

interface Step {
  step: number;
  name: string;
  at: string;
  [k: string]: unknown;
}
const record: {
  run: string;
  base_url: string;
  started_at: string;
  steps: Step[];
  ids: Record<string, string>;
} = {
  run: RUN,
  base_url: process.env.E2E_BASE_URL ?? "",
  started_at: new Date().toISOString(),
  steps: [],
  ids: {},
};
const note = (step: number, name: string, extra: Record<string, unknown> = {}) => {
  record.steps.push({ step, name, at: new Date().toISOString(), ...extra });
  writeFileSync(join(OUT, "run.json"), JSON.stringify(record, null, 2));
};
const shot = (page: Page, name: string) =>
  page.screenshot({ path: join(OUT, `${name}.png`), fullPage: false });
let lastSeen = "(no API call yet)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function api<T = Record<string, unknown>>(
  page: Page,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await page.request.fetch(path, {
    method,
    headers: { accept: "application/json", ...headers },
    ...(body === undefined ? {} : { data: body }),
    timeout: 30_000,
  });
  const parsed = (await res.json().catch(() => ({}))) as T;
  lastSeen = `${method} ${path} -> ${res.status()} ${JSON.stringify(parsed).slice(0, 600)}`;
  return { status: res.status(), body: parsed };
}

async function poll<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs: number,
  everyMs = 3_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs)
      throw new Error(`timed out after ${timeoutMs} ms: ${label}. Last API answer: ${lastSeen}`);
    await sleep(everyMs);
  }
}

let page: Page;
const docs: Record<string, string> = {};
const payments: Record<string, { id: string; transferId: string | null }> = {};
let rfiAirwallexId = "";
let rfiId = "";

// E2E_RESUME=1 continues a run whose steps 2-5 already passed (state.json in the evidence dir), so a
// retry after an environment problem does not create more real transfers or spend more model tokens.
const STATE = join(OUT, "state.json");
const resume = process.env.E2E_RESUME === "1";
const saveState = () => writeFileSync(STATE, JSON.stringify({ docs, payments }, null, 2));
if (resume) {
  const saved = JSON.parse(readFileSync(STATE, "utf8")) as {
    docs: Record<string, string>;
    payments: typeof payments;
  };
  Object.assign(docs, saved.docs);
  Object.assign(payments, saved.payments);
  // Keep the earlier steps in the run record: this run only adds steps 6-8 to it.
  Object.assign(record, JSON.parse(readFileSync(join(OUT, "run.json"), "utf8")));
}

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000" });
});
test.afterAll(async () => {
  await page.close();
});

test("1. sign in as the seeded owner on the deployed app", async () => {
  const res = await page.request.post("/api/auth/sign-in/email", {
    data: { email: ownerEmail, password: ownerPassword },
  });
  // The body names the reason (never the password); a wrong password is 401, 400 means a bad request.
  expect(res.status(), `sign-in ${ownerEmail}: ${await res.text()}`).toBe(200);
  const health = await (await page.request.get("/healthz")).json();
  note(1, "owner signed in", { deployed_version: health.version });
});

/**
 * Uploads one dataset PDF. The kind decides whether extraction is queued (only for a NEW document of an
 * extractable kind), so it is sent, as the upload screen does. A re-upload of identical bytes is
 * deduplicated and queues nothing, and no API changes a stored kind (BL-01), so each run inserts one PDF
 * comment line just before `startxref`: the hash is new, the xref offsets and the text layer are
 * unchanged (checked with unpdf: same page count, identical text). Bytes after %%EOF are rejected as
 * corrupt. The run record states this.
 */
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

test("2. upload the dataset documents; extraction completes; the scan needs confirmation", async () => {
  test.skip(resume, "resuming: this step already passed in the earlier run (state.json)");
  test.setTimeout(240_000);
  const files = [
    "inv-harbor-001",
    "po-harbor-001",
    "contract-harbor",
    "inv-lakeside-001",
    "inv-lakeside-002",
    "inv-nordlicht-scan-001",
  ];
  for (const f of files) {
    const kind = f.startsWith("inv-")
      ? "invoice"
      : f.startsWith("po-")
        ? "purchase_order"
        : "contract";
    docs[f] = await uploadDataset(f, kind);
  }
  // Facts: wait until every text-layer document has a verified version (the worker reads them).
  const facts: Record<string, unknown> = {};
  for (const f of files) {
    const got = await poll(
      `facts of ${f}`,
      async () => {
        const r = await api<Record<string, unknown>>(
          page,
          "GET",
          `/api/v1/documents/${docs[f]}/facts`,
        );
        const s = JSON.stringify(r.body);
        return r.status === 200 && /"quote_verified":(true|false)/.test(s) ? r.body : null;
      },
      200_000,
    );
    facts[f] = got;
  }
  const scan = JSON.stringify(facts["inv-nordlicht-scan-001"]);
  expect(scan).toContain('"needs_confirmation":true'); // image-only: no fact usable until confirmed
  const inj = JSON.stringify(facts["inv-lakeside-002"]);
  note(2, "documents uploaded and read", {
    documents: docs,
    scan_needs_confirmation: true,
    injection_document_mentions_flag: /injection|instruction/i.test(inj),
  });
  record.ids.documents = JSON.stringify(docs);
  saveState();
});

test("3. confirm the scan's facts as the owner (image-only needs a person)", async () => {
  test.skip(resume, "resuming: this step already passed in the earlier run (state.json)");
  const f = await api<{ version?: number; latest_version?: number }>(
    page,
    "GET",
    `/api/v1/documents/${docs["inv-nordlicht-scan-001"]}/facts`,
  );
  const version = f.body.version ?? f.body.latest_version ?? 1;
  const res = await api(
    page,
    "POST",
    `/api/v1/documents/${docs["inv-nordlicht-scan-001"]}/facts/${version}/confirm`,
    {},
  );
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  note(3, "scan facts confirmed by the owner", { confirmed_version: version, status: res.status });
});

test("4. create two payments, attach evidence, see Strong and a not-Strong flag", async () => {
  test.skip(resume, "resuming: this step already passed in the earlier run (state.json)");
  test.setTimeout(120_000);
  const create = async (counterparty: string, amount: string, ref: string) => {
    const res = await api<{ payment: { id: string } }>(
      page,
      "POST",
      "/api/v1/payments",
      {
        amount: { amount, currency: "USD" },
        reference: ref,
        counterparty_id: counterparty,
        send: false,
      },
      { "idempotency-key": `${RUN}-${ref}` },
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.payment.id;
  };
  const strong = await create(HARBOR, "4800.00", `${RUN}-001`);
  const weak = await create(LAKESIDE, "1320.50", `${RUN}-003`);
  payments.strong = { id: strong, transferId: null };
  payments.weak = { id: weak, transferId: null };
  const attach = async (pid: string, names: string[]) => {
    for (const n of names) {
      const r = await api(page, "POST", `/api/v1/payments/${pid}/evidence-links`, {
        document_id: docs[n],
      });
      expect([200, 201], JSON.stringify(r.body)).toContain(r.status);
    }
  };
  await attach(strong, ["inv-harbor-001", "po-harbor-001", "contract-harbor"]);
  await attach(weak, ["inv-lakeside-001"]);
  const flagOf = async (pid: string) => {
    const r = await api<Record<string, unknown>>(
      page,
      "GET",
      `/api/v1/payments/${pid}/evidence-check`,
    );
    const flag = (r.body.flag ?? (r.body.check as { flag?: string } | undefined)?.flag) as string;
    return { flag, body: r.body };
  };
  const a = await poll(
    "strong payment flag",
    async () => {
      const c = await flagOf(strong);
      return c.flag === "strong" ? c : c.flag === "weak" || c.flag === "missing" ? c : null;
    },
    90_000,
  );
  const b = await flagOf(weak);
  note(4, "payments saved, evidence attached, flags computed", {
    strong_payment: strong,
    weak_payment: weak,
    flag_harbor: a.flag,
    flag_lakeside: b.flag,
  });
  expect(a.flag).toBe("strong");
  expect(b.flag).not.toBe("strong");
  await page.goto("/payments");
  await expect(page.getByRole("heading", { level: 1, name: "Payments" })).toBeVisible();
  await shot(page, "01-queue-with-flags");
  await page.goto(`/payments/${weak}/evidence`);
  await expect(page.getByTestId("reasons")).toBeVisible();
  await shot(page, "02-evidence-view-weak");
});

test("5. send both: the Weak one only after the acknowledgement; real sandbox transfers", async () => {
  test.skip(resume, "resuming: this step already passed in the earlier run (state.json)");
  test.setTimeout(180_000);
  // Without the acknowledgement the server refuses (412) and sends nothing.
  const refused = await api(page, "POST", `/api/v1/payments/${payments.weak?.id}/send`, {});
  expect(refused.status).toBe(412);
  const ok1 = await api(page, "POST", `/api/v1/payments/${payments.strong?.id}/send`, {});
  expect(ok1.status, JSON.stringify(ok1.body)).toBe(200);
  const ok2 = await api(page, "POST", `/api/v1/payments/${payments.weak?.id}/send`, {
    evidence_ack: { acknowledged: true },
  });
  expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
  for (const key of ["strong", "weak"] as const) {
    const p = payments[key];
    if (!p) throw new Error("payment missing");
    const d = await poll(
      `${key} transfer created`,
      async () => {
        const r = await api<{
          payment: { transfer_id: string | null; transfer_status: string | null };
        }>(page, "GET", `/api/v1/payments/${p.id}`);
        return r.body.payment.transfer_id ? r.body.payment : null;
      },
      150_000,
    );
    p.transferId = d.transfer_id;
  }
  saveState();
  note(5, "payments sent (real sandbox transfers)", {
    weak_send_without_ack_status: refused.status,
    transfers: { strong: payments.strong?.transferId, weak: payments.weak?.transferId },
  });
});

test("5b. upload the delivery note and the remittance advice the RFI's attachment questions need", async () => {
  // pay-001's RFI asks for proof of delivery and source of funds (fixtures/dataset/rfi-sets/rfi-set-harbor.json);
  // without these two documents on file those questions are NEEDS_OWNER by design (first live attempt).
  // Neither has an extraction schema: kind `other`, as in the recorded M2-08 seed.
  for (const f of ["dn-harbor-001", "remit-brightline-001"]) {
    if (!docs[f]) docs[f] = await uploadDataset(f, "other");
  }
  saveState();
  note(5, "supporting documents uploaded for the RFI's attachment questions", {
    delivery_note: docs["dn-harbor-001"],
    remittance_advice: docs["remit-brightline-001"],
  });
});

let simulator: ReturnType<typeof createAirwallexClient>["simulator"];

test("6. a real simulated TRANSACTION RFI on the strong payment's transfer; the webhook reaches Carnet", async () => {
  test.setTimeout(300_000);
  const client = createAirwallexClient(configFromEnv(process.env));
  simulator = client.simulator;
  const transferId = payments.strong?.transferId;
  if (!transferId) throw new Error("no transfer");
  // An earlier attempt's RFI (first live run: the supporting documents were missing, so its questions
  // were NEEDS_OWNER by design) is closed first: one open RFI per type and source. It stays in the record.
  const previous = record.ids.rfi_airwallex;
  if (previous) {
    try {
      await simulator.closeRfi(previous);
      note(6, "previous attempt's RFI closed", { rfi_airwallex_id: previous });
    } catch (error) {
      note(6, "previous RFI could not be closed (already closed?)", {
        rfi_airwallex_id: previous,
        error: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  }
  // A TRANSFER source must already be PROCESSING (M0-04); the simulator moves it there. A repeat on a
  // transfer that is already PROCESSING is tolerated.
  try {
    await simulator.transitionTransfer(transferId, "PROCESSING");
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
  const tCreate = Date.now();
  const rfi = await simulator.createRfi({ type: "TRANSACTION", questions });
  rfiAirwallexId = rfi.id;
  const found = await poll(
    "the RFI reaches Carnet through the signed webhook",
    async () => {
      const r = await api<{ items: Record<string, unknown>[] }>(page, "GET", "/api/v1/rfis");
      return r.body.items?.find((i) => JSON.stringify(i).includes(rfiAirwallexId)) ?? null;
    },
    240_000,
  );
  rfiId = String((found as { id: string }).id);
  note(6, "simulated RFI created and received", {
    rfi_airwallex_id: rfiAirwallexId,
    rfi_id: rfiId,
    creation_path:
      "SandboxSimulator port, POST /api/v1/simulation/rfis/create (plain account, ADR 0018)",
    ms_create_to_visible_in_carnet: Date.now() - tCreate,
    questions: questions.length,
  });
  record.ids.rfi = rfiId;
  record.ids.rfi_airwallex = rfiAirwallexId;
});

test("7. real-model drafts with verified citations; the owner approves; the respond executes; ANSWERED", async () => {
  test.setTimeout(600_000);
  const tStart = Date.now();
  const ready = await poll(
    "DRAFT_READY",
    async () => {
      const r = await api<{
        rfi?: { state: string };
        draft: { state: string } | null;
        questions?: unknown[];
      }>(page, "GET", `/api/v1/rfis/${rfiId}/hold`);
      writeFileSync(join(OUT, "hold-last.json"), JSON.stringify(r.body, null, 2));
      if (r.body.rfi?.state === "NEEDS_OWNER") {
        throw new Error(
          "the RFI is NEEDS_OWNER: the model could not ground at least one question in the documents on file. " +
            "Full hold view in hold-last.json (question statuses and reasons).",
        );
      }
      return r.body.draft?.state === "DRAFT_READY" ? r.body : null;
    },
    300_000,
    4_000,
  );
  const tDraft = Date.now();
  note(7, "draft ready (real model)", { ms_poll_start_to_draft_ready: tDraft - tStart });
  await page.goto(`/rfis/${rfiId}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
  await expect(page.getByTestId("question").first()).toBeVisible();
  await expect(page.getByTestId("source-snippet").first()).toContainText("Quote verified");
  await shot(page, "03-hold-screen-with-snippets");
  const held = JSON.stringify(ready);
  expect(held).toContain("citations");
  // Approve through the UI: the approval is bound to the exact content shown.
  await page.getByTestId("approve-button").click();
  const dialog = page.getByTestId("approve-dialog");
  await expect(dialog).toBeVisible();
  await shot(page, "04-approval-dialog");
  const tApprove = Date.now();
  await dialog
    .getByRole("button", { name: /approve|send/i })
    .last()
    .click();
  const done = await poll(
    "RFI ANSWERED with a CONFIRMED attempt",
    async () => {
      const r = await api<{
        rfi: { state: string };
        attempt: { status: string; request_id: string } | null;
        approval: { status: string } | null;
      }>(page, "GET", `/api/v1/rfis/${rfiId}/hold`);
      return r.body.rfi.state === "ANSWERED" && r.body.attempt?.status === "CONFIRMED"
        ? r.body
        : null;
    },
    240_000,
    3_000,
  );
  note(7, "approved, responded, answered", {
    ms_approval_to_answered: Date.now() - tApprove,
    attempt: done.attempt,
    approval_status: done.approval?.status,
  });
  await page.reload();
  await shot(page, "05-answered-state");
});

test("8. the simulator closes the RFI; the transfer reaches SENT and PAID on its own status", async () => {
  test.setTimeout(300_000);
  await simulator.closeRfi(rfiAirwallexId);
  const closed = await poll(
    "Carnet shows the RFI closed",
    async () => {
      const r = await api<{ rfi: { state: string } }>(page, "GET", `/api/v1/rfis/${rfiId}/hold`);
      return r.body.rfi.state === "CLOSED" ? r.body : null;
    },
    180_000,
  );
  const sp = payments.strong;
  if (!sp) throw new Error("no strong payment");
  const statusOf = async () =>
    (
      await api<{ payment: { transfer_status: string | null } }>(
        page,
        "GET",
        `/api/v1/payments/${sp.id}`,
      )
    ).body.payment.transfer_status;
  const duringClose = await statusOf();
  // The RFI event alone changed nothing about the money status: it is still what the transfer says.
  expect(duringClose).not.toBe("SENT");
  expect(duringClose).not.toBe("PAID");
  for (const next of ["SENT", "PAID"] as const) {
    const r = await api(page, "POST", `/api/v1/payments/${sp.id}/simulate`, { next_status: next });
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    await poll(
      `transfer ${next}`,
      async () => ((await statusOf()) === next ? true : null),
      120_000,
    );
  }
  const detail = await api<{ payment: unknown; webhooks: unknown[] }>(
    page,
    "GET",
    `/api/v1/payments/${sp.id}`,
  );
  writeFileSync(join(OUT, "strong-payment-detail.json"), JSON.stringify(detail.body, null, 2));
  note(8, "RFI closed; transfer reached SENT then PAID on its own status", {
    transfer_status_while_rfi_closed: duringClose,
    final_transfer_status: await statusOf(),
    rfi_state: (closed as { rfi: { state: string } }).rfi.state,
    transfer_id: sp.transferId,
  });
  await page.goto("/payments");
  await shot(page, "06-queue-after-run");
});
