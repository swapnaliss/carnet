import { record, requireEnv } from "./lib.mjs";
import {
  closeAllOpenRfis,
  closeRfi,
  createRfi,
  freshTransfer,
  getRfi,
  getTransfer,
  question,
  respond,
} from "./rfi-lib.mjs";

requireEnv();

// Check 5: close an RFI (open, then answered) and see what happens to the transfer.
export async function run() {
  await closeAllOpenRfis();
  const t = await freshTransfer("rfi-check5-transfer-create");
  const before = (await getTransfer("tmp-g", t.id)).body.status;
  const c = await createRfi("rfi-check5-create", {
    transferIds: [t.id],
    questions: [question("TEXT", "Purpose?")],
  });
  const cl = await closeRfi("rfi-check5-close-open", c.body.id);
  const g = await getRfi("rfi-check5-fetch-after-close", c.body.id);
  const tf = await getTransfer("rfi-check5-transfer-after-close", t.id);
  // respond on a closed RFI
  const q = c.body.active_request.questions[0];
  const rc = await respond("rfi-check5-respond-after-close", c.body.id, [
    { id: q.id, answer: { type: "TEXT", text: "late" } },
  ]);
  // close an already closed RFI
  const cl2 = await closeRfi("rfi-check5-close-again", c.body.id);
  // answered then closed
  const c2 = await createRfi("rfi-check5-create-2", {
    transferIds: [t.id],
    questions: [question("TEXT", "Purpose again?")],
  });
  await respond("rfi-check5-respond-2", c2.body.id, [
    { id: c2.body.active_request.questions[0].id, answer: { type: "TEXT", text: "answer" } },
  ]);
  const tAnswered = (await getTransfer("rfi-check5-transfer-after-answer", t.id)).body.status;
  const cl3 = await closeRfi("rfi-check5-close-answered", c2.body.id);
  const g3 = await getRfi("rfi-check5-fetch-after-close-answered", c2.body.id);
  const out = {
    transferBefore: before,
    closeOpen: { status: cl.status, body: cl.body?.status ?? cl.body },
    fetchAfterClose: g.body.status,
    transferAfterClose: tf.body.status,
    respondAfterClose: { status: rc.status, body: rc.body },
    closeAgain: { status: cl2.status, body: cl2.body?.status ?? cl2.body },
    transferAfterAnswer: tAnswered,
    closeAnswered: { status: cl3.status, rfiStatus: g3.body.status },
  };
  record("rfi-check5-summary", out);
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await run(), null, 1));
