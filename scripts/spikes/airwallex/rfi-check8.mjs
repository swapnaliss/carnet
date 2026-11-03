import { newTransfer } from "./04-transitions.mjs";
import { call, must, record, requireEnv } from "./lib.mjs";
import {
  beneficiaryIds,
  closeAllOpenRfis,
  closeRfi,
  createRfi,
  getTransfer,
  question,
} from "./rfi-lib.mjs";

requireEnv();

const bal = async (name) => {
  const b = must(await call(name, "GET", "/api/v1/balances/current"));
  return b.find((x) => x.currency === "USD");
};

// Check 8: are held funds visible in balances while an RFI is open?
export async function run() {
  await closeAllOpenRfis();
  const before = await bal("rfi-check8-balances-before-transfer");
  const t = await newTransfer(
    "rfi-check8-transfer-create",
    beneficiaryIds().us,
    "USD",
    "LOCAL",
    40,
  );
  const created = await bal("rfi-check8-balances-after-create");
  for (let i = 0; i < 15; i++) {
    if ((await getTransfer("tmp-w", t.id)).body.status === "PROCESSING") break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const processing = await bal("rfi-check8-balances-processing");
  const c = await createRfi("rfi-check8-create-rfi", {
    transferIds: [t.id],
    questions: [question("TEXT", "Purpose?")],
  });
  const open = await bal("rfi-check8-balances-rfi-open");
  const tf = await getTransfer("rfi-check8-transfer-rfi-open", t.id);
  await call("rfi-check8-available-balances", "GET", "/api/v1/balances/current");
  await closeRfi("rfi-check8-close", c.body.id);
  const closed = await bal("rfi-check8-balances-after-close");
  const out = {
    before,
    created,
    processing,
    rfiOpen: open,
    afterClose: closed,
    transferStatusWhileOpen: tf.body.status,
    fundingWhileOpen: tf.body.funding,
  };
  record("rfi-check8-summary", out);
  await closeAllOpenRfis();
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await run(), null, 1));
