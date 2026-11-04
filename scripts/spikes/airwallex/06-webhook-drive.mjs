// M0-05: drive the sandbox so that webhook deliveries happen. Calls use `tmp-` names (not recorded as API fixtures).
// Prints a timeline (ISO time, action, ids) to stdout; compare with the receiver's WEBHOOK log lines.
import { newTransfer, transition } from "./04-transitions.mjs";
import { call, requireEnv, sleep } from "./lib.mjs";
import {
  beneficiaryIds,
  closeAllOpenRfis,
  closeRfi,
  createRfi,
  freshTransfer,
  question,
  respond,
} from "./rfi-lib.mjs";

requireEnv();
const log = (action, extra = {}) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), action, ...extra }));
const part = process.argv[2] ?? "all";

async function rfiFlow() {
  await closeAllOpenRfis();
  const t = await freshTransfer("tmp-wh-rfi-transfer");
  log("transfer.created.processing", { transfer: t.id });
  const c = await createRfi("tmp-wh-rfi-create", {
    transferIds: [t.id],
    questions: [question("TEXT", "Purpose of this payment?")],
  });
  const rfi = c.body;
  log("rfi.created", { rfi: rfi.id, status: c.status });
  await sleep(8000);
  const q = rfi.active_request.questions[0];
  const r = await respond("tmp-wh-rfi-respond", rfi.id, [
    { id: q.id, answer: { type: "TEXT", text: "Payment for supplier invoice INV-1001" } },
  ]);
  log("rfi.responded", { rfi: rfi.id, status: r.status });
  await sleep(8000);
  const cl = await closeRfi("tmp-wh-rfi-close", rfi.id);
  log("rfi.closed", { rfi: rfi.id, status: cl.status });
  await sleep(8000);
}

// The simulator sometimes answers 500 slowly yet applies the change: retry, then confirm by fetching.
async function step(name, id, next) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = await transition(name, id, { next_status: next });
    if (r.status < 300) return r;
    await sleep(4000);
    const g = await call("tmp-wh-check", "GET", `/api/v1/transfers/${id}`);
    log("transition.retry", { next, status: r.status, now: g.body.status });
    if (g.body.status === next || (next === "FAILED" && g.body.status === "CANCELLED")) return r;
  }
  return r;
}

async function transferFlow(finalStatus, label) {
  const t = await newTransfer(`tmp-wh-${label}`, beneficiaryIds().us, "USD", "LOCAL", 20);
  log("transfer.created", { label, transfer: t.id });
  for (let i = 0; i < 15; i++) {
    const g = await call("tmp-wh-wait", "GET", `/api/v1/transfers/${t.id}`);
    if (g.body.status === "PROCESSING") {
      log("transfer.observed.PROCESSING", { label, transfer: t.id });
      break;
    }
    await sleep(1000);
  }
  await sleep(5000);
  const s = await step(`tmp-wh-${label}-sent`, t.id, "SENT");
  log("transfer.transition.SENT", { label, transfer: t.id, status: s.status });
  await sleep(6000);
  const f = await step(`tmp-wh-${label}-final`, t.id, finalStatus);
  log(`transfer.transition.${finalStatus}`, { label, transfer: t.id, status: f.status });
  await sleep(8000);
}

if (part === "all" || part === "rfi") await rfiFlow();
if (part === "all" || part === "paid") await transferFlow("PAID", "paid");
if (part === "all" || part === "failed") await transferFlow("FAILED", "failed");
log("done");
