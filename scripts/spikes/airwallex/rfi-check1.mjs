import { newTransfer } from "./04-transitions.mjs";
import { call, requireEnv, sleep } from "./lib.mjs";
import {
  beneficiaryIds,
  closeAllOpenRfis,
  createRfi,
  getRfi,
  getTransfer,
  question,
} from "./rfi-lib.mjs";

requireEnv();

// Check 1: plain-account creation (no x-on-behalf-of), TEXT + ATTACHMENT, TRANSFER source.
export async function run() {
  await closeAllOpenRfis();
  const t = await newTransfer(
    "rfi-check1-transfer-create",
    beneficiaryIds().us,
    "USD",
    "LOCAL",
    20,
  );
  const qs = [
    question("TEXT", "What is the purpose of this payment?"),
    question("ATTACHMENT", "Upload the supplier invoice"),
  ];
  // right after creation the transfer is SCHEDULED
  const early = await createRfi("rfi-check1-create-while-scheduled", {
    transferIds: [t.id],
    questions: qs,
  });
  if (early.status === 200) await closeAllOpenRfis();
  for (let i = 0; i < 15; i++) {
    if ((await getTransfer("tmp-w", t.id)).body.status === "PROCESSING") break;
    await sleep(1000);
  }
  const r = await createRfi("rfi-check1-create", { transferIds: [t.id], questions: qs });
  if (r.status !== 200 && r.status !== 201)
    return { ok: false, status: r.status, body: r.body, earlyStatus: early.status };
  const after = await getTransfer("rfi-check1-transfer-after", t.id);
  await getRfi("rfi-check1-fetch", r.body.id);
  await call(
    "rfi-check1-list",
    "GET",
    "/api/v1/rfis?statuses=ACTION_REQUIRED&types=TRANSACTION&page_size=10",
  );
  return {
    ok: true,
    rfi: r.body,
    transferId: t.id,
    transferStatusAfter: after.body.status,
    earlyStatus: early.status,
  };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(await run());
