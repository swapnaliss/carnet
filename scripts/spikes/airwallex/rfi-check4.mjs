import { transition } from "./04-transitions.mjs";
import { record, requireEnv, sleep } from "./lib.mjs";
import {
  closeAllOpenRfis,
  createRfi,
  freshTransfer,
  getRfi,
  getTransfer,
  question,
} from "./rfi-lib.mjs";

requireEnv();

// Check 4: transition the transfer while its RFI is open.
export async function run() {
  const out = {};
  for (const [label, steps] of [
    ["paid", [["SENT"], ["PAID"]]],
    ["failed", [["SENT"], ["FAILED", "BENEFICIARY_BANK_RETURNED"]]],
  ]) {
    await closeAllOpenRfis();
    const t = await freshTransfer(`rfi-check4-transfer-create-${label}`);
    const c = await createRfi(`rfi-check4-create-${label}`, {
      transferIds: [t.id],
      questions: [question("TEXT", "Purpose?")],
    });
    const seq = [
      {
        step: "open",
        transfer: (await getTransfer("tmp-g", t.id)).body.status,
        rfi: c.body.status,
      },
    ];
    for (const [next, ft] of steps) {
      const tr = await transition(`rfi-check4-transition-${label}-${next.toLowerCase()}`, t.id, {
        next_status: next,
        ...(ft ? { failure_type: ft } : {}),
      });
      let retried;
      if (tr.status !== 200) {
        await sleep(2000);
        const seen = (await getTransfer("tmp-g", t.id)).body.status;
        retried = { seenAfter2s: seen };
        if (seen !== next && !(next === "FAILED" && seen === "CANCELLED")) {
          const again = await transition(
            `rfi-check4-transition-${label}-${next.toLowerCase()}-retry`,
            t.id,
            { next_status: next, ...(ft ? { failure_type: ft } : {}) },
          );
          retried.retryHttp = again.status;
        }
      }
      const tf = await getTransfer(`rfi-check4-transfer-${label}-${next.toLowerCase()}`, t.id);
      const rf = await getRfi(`rfi-check4-rfi-${label}-${next.toLowerCase()}`, c.body.id);
      seq.push({
        step: next,
        http: tr.status,
        retried,
        transfer: tf.body.status,
        failure: tf.body.failure,
        rfi: rf.body.status,
      });
    }
    out[label] = seq;
  }
  await closeAllOpenRfis();
  record("rfi-check4-summary", out);
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(out2(await run()), null, 1));
function out2(x) {
  return x;
}
