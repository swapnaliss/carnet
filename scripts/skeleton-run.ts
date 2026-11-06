// Headless walking-skeleton run (M1-08): drives the deployed Carnet through the same flow as the UI.
//   DEPLOY_URL=https://… E2E_OWNER_PASSWORD=… npx tsx scripts/skeleton-run.ts --out "$TMPDIR/skeleton-run.json"
// Env key names (values come from the environment, never printed or written to the log):
//   DEPLOY_URL, E2E_OWNER_EMAIL (default owner@carnet.example), E2E_OWNER_PASSWORD (or SEED_OWNER_PASSWORD),
//   E2E_JUDGE_PASSWORD (or SEED_JUDGE_PASSWORD, optional: adds the read-only checks).
// Steps: sign in as owner -> create a payment (Idempotency-Key) -> replay the key -> poll until the
// worker has created the transfer and the attempt is CONFIRMED -> ask the sandbox for SENT then PAID
// -> poll until each status is stored -> collect the webhooks Carnet received -> viewer checks.
// Calls are sequential (the sandbox allows 10 concurrent; this makes at most one at a time).
// The run log has no cookies, passwords or tokens; sandbox ids are not secrets.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

interface Attempt {
  status: string;
  request_id: string;
  created_at: string;
  sent_at: string | null;
  confirmed_at: string | null;
  sends: number;
}
interface Payment {
  id: string;
  reference: string;
  transfer_id: string | null;
  transfer_status: string | null;
  transfer_updated_at: string | null;
  view: string | null;
  attempt: Attempt | null;
}
interface Webhook {
  event_id: string;
  name: string;
  signature_ok: boolean;
  received_at: string;
  acked_at: string | null;
  processed_at: string | null;
  raw_body?: string;
}
interface Detail {
  payment: Payment;
  webhooks: Webhook[];
  server_time: string;
}

const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const outPath = outIdx >= 0 ? args[outIdx + 1] : undefined;
const webhookDirIdx = args.indexOf("--webhooks-out");
const webhookOut = webhookDirIdx >= 0 ? args[webhookDirIdx + 1] : undefined;
const amountIdx = args.indexOf("--amount");
const amount = amountIdx >= 0 ? (args[amountIdx + 1] ?? "25.00") : "25.00";

function need(key: string, ...alts: string[]): string {
  for (const k of [key, ...alts]) {
    const v = process.env[k];
    if (v) return v;
  }
  console.error(`missing environment variable ${key}`);
  process.exit(2);
}

const base = need("DEPLOY_URL").replace(/\/$/, "");
const ownerEmail = process.env.E2E_OWNER_EMAIL ?? "owner@carnet.example";
const ownerPassword = need("E2E_OWNER_PASSWORD", "SEED_OWNER_PASSWORD");
const judgePassword = process.env.E2E_JUDGE_PASSWORD ?? process.env.SEED_JUDGE_PASSWORD;
const t0 = Date.now();
const log: Record<string, unknown> = {
  deploy_url: base,
  started_at: new Date(t0).toISOString(),
  steps: [] as unknown[],
};
const step = (name: string, data: Record<string, unknown> = {}) =>
  (log.steps as unknown[]).push({ at_ms: Date.now() - t0, name, ...data });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signIn(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ email, password }),
  });
  if (res.status !== 200) throw new Error(`sign-in failed for ${email} with ${res.status}`);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function api<T>(
  cookie: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie,
      origin: base,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function waitFor(
  cookie: string,
  id: string,
  label: string,
  done: (d: Detail) => boolean,
  timeoutMs = 120_000,
): Promise<Detail> {
  const start = Date.now();
  for (;;) {
    const { status, body } = await api<Detail>(cookie, "GET", `/api/v1/payments/${id}`);
    if (status === 200 && done(body)) {
      step(`reached: ${label}`, {
        transfer_status: body.payment.transfer_status,
        waited_ms: Date.now() - start,
      });
      return body;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(2_000);
  }
}

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);

async function main() {
  const owner = await signIn(ownerEmail, ownerPassword);
  step("owner signed in");

  const key = crypto.randomUUID();
  const reference = `M1-08 skeleton ${new Date().toISOString().slice(0, 19)}Z`;
  const payload = { amount: { amount, currency: "USD" }, reference };
  const created = await api<{ payment: Payment }>(owner, "POST", "/api/v1/payments", payload, {
    "idempotency-key": key,
  });
  if (created.status !== 201) throw new Error(`create returned ${created.status}`);
  const id = created.body.payment.id;
  step("payment created", { payment_id: id, status: created.status });

  const replay = await api<{ payment: Payment }>(owner, "POST", "/api/v1/payments", payload, {
    "idempotency-key": key,
  });
  const list = await api<{ items: Payment[] }>(owner, "GET", "/api/v1/payments");
  const same = list.body.items.filter((p) => p.reference === reference);
  step("idempotent replay", { status: replay.status, same_id: replay.body.payment.id === id });

  const confirmed = await waitFor(
    owner,
    id,
    "attempt CONFIRMED with a transfer",
    (d) => d.payment.attempt?.status === "CONFIRMED" && d.payment.transfer_id !== null,
  );
  const transferId = confirmed.payment.transfer_id as string;

  // The sandbox moves a new transfer to PROCESSING by itself; SENT is only accepted after that.
  await waitFor(owner, id, "PROCESSING", (d) => d.payment.transfer_status === "PROCESSING");
  const simulations: Array<Record<string, unknown>> = [];
  for (const next of ["SENT", "PAID"] as const) {
    const requestedAt = Date.now();
    const q = await api(owner, "POST", `/api/v1/payments/${id}/simulate`, { next_status: next });
    if (q.status !== 202) throw new Error(`simulate ${next} returned ${q.status}`);
    const d = await waitFor(owner, id, next, (x) => x.payment.transfer_status === next);
    simulations.push({
      next_status: next,
      queued_to_stored_ms: Date.now() - requestedAt,
      transfer_updated_at: d.payment.transfer_updated_at,
    });
  }

  // Give the remaining webhooks a moment to arrive and be applied, then read the evidence.
  await sleep(5_000);
  const finalDetail = (await api<Detail>(owner, "GET", `/api/v1/payments/${id}`)).body;
  const p = finalDetail.payment;
  const attempt = p.attempt;

  let viewer: Record<string, unknown> | null = null;
  if (judgePassword) {
    const judge = await signIn("judge@carnet.example", judgePassword);
    const denied = await api(judge, "POST", "/api/v1/payments", payload, {
      "idempotency-key": crypto.randomUUID(),
    });
    const seen = await api<{ items: Payment[] }>(judge, "GET", "/api/v1/payments");
    viewer = {
      create_status: denied.status,
      list_status: seen.status,
      list_count: seen.body.items.length,
    };
    step("viewer checked", viewer);
  }

  const webhooks = finalDetail.webhooks.map((w) => ({
    event_id: w.event_id,
    name: w.name,
    signature_ok: w.signature_ok,
    received_at: w.received_at,
    acked_at: w.acked_at,
    processed_at: w.processed_at,
    ack_ms: w.acked_at ? ms(w.acked_at) - ms(w.received_at) : null,
    apply_ms: w.processed_at ? ms(w.processed_at) - ms(w.received_at) : null,
  }));

  Object.assign(log, {
    finished_at: new Date().toISOString(),
    payment_id: id,
    transfer_id: transferId,
    request_id: attempt?.request_id ?? null,
    attempt_status: attempt?.status ?? null,
    attempt: attempt && {
      created_at: attempt.created_at,
      sent_at: attempt.sent_at,
      confirmed_at: attempt.confirmed_at,
      sends: attempt.sends,
      row_before_call: ms(attempt.created_at) <= ms(attempt.sent_at),
    },
    ui_status: p.view,
    transfer_status: p.transfer_status,
    idempotency: {
      replay_status: replay.status,
      replay_same_payment: replay.body.payment.id === id,
      payments_with_reference: same.length,
    },
    simulations,
    webhooks,
    webhooks_all_signature_ok: webhooks.length > 0 && webhooks.every((w) => w.signature_ok),
    viewer,
  });
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(log, null, 2)}\n`);
  }
  if (webhookOut) {
    mkdirSync(webhookOut, { recursive: true });
    for (const w of finalDetail.webhooks) {
      if (!w.raw_body) continue;
      writeFileSync(
        `${webhookOut}/${w.name}.${w.event_id.slice(0, 8)}.json`,
        `${JSON.stringify({ name: w.name, received_at: w.received_at, signature_ok: w.signature_ok, body_utf8: w.raw_body }, null, 2)}\n`,
      );
    }
  }
  console.log(
    JSON.stringify({
      transfer_id: transferId,
      attempt_status: attempt?.status,
      ui_status: p.view,
      webhooks: webhooks.length,
    }),
  );
}

main().catch((error) => {
  step("failed", { error: error instanceof Error ? error.message : String(error) });
  if (outPath) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${JSON.stringify(log, null, 2)}\n`);
  }
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
