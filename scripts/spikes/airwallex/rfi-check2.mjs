import { record, requireEnv } from "./lib.mjs";
import {
  closeAllOpenRfis,
  closeRfi,
  createRfi,
  freshTransfer,
  getRfi,
  PDF,
  question,
  respond,
  upload,
} from "./rfi-lib.mjs";

requireEnv();

// Check 2: partial respond, full respond, respond again after ANSWERED. Also the one-open rule and follow_up.
export async function run() {
  await closeAllOpenRfis();
  const t = await freshTransfer("rfi-check2-transfer-create");
  const c = await createRfi("rfi-check2-create", {
    transferIds: [t.id],
    questions: [question("TEXT", "Purpose?"), question("ATTACHMENT", "Invoice?")],
  });
  const rfi = c.body;
  const [qt, qa] = rfi.active_request.questions;
  const file = await upload("rfi-check2-upload-pdf", PDF, "invoice.pdf", "application/pdf");
  const fileId = file.body.file_id;
  const text = {
    id: qt.id,
    answer: { type: "TEXT", text: "Payment for supplier invoice INV-1001" },
  };
  const att = { id: qa.id, answer: { type: "ATTACHMENT", attachments: [{ file_id: fileId }] } };
  const partialText = await respond("rfi-check2-respond-partial-text", rfi.id, [text]);
  const partialAtt = await respond("rfi-check2-respond-partial-attachment", rfi.id, [att]);
  const afterPartial = await getRfi("rfi-check2-fetch-after-partial", rfi.id);
  const oneOpen = await createRfi("rfi-oneopen-second-create-while-open", {
    transferIds: [t.id],
    questions: [question("TEXT", "Second?")],
  });
  const full = await respond("rfi-check2-respond-full", rfi.id, [text, att]);
  const afterFull = await getRfi("rfi-check2-fetch-after-full", rfi.id);
  const again = await respond("rfi-check2-respond-again-after-answered", rfi.id, [text, att]);
  // follow_up: reopen the text question by id and append a new one (repeating a title)
  const fu = await (await import("./lib.mjs")).call(
    "rfi-followup-reopen-and-append",
    "POST",
    `/api/v1/simulation/rfis/${rfi.id}/follow_up`,
    {
      body: {
        questions: [
          { id: qt.id },
          { ...question("TEXT", "Purpose?"), sources: [{ id: t.id, type: "TRANSFER" }] },
        ],
      },
    },
  );
  const afterFu = await getRfi("rfi-followup-fetch", rfi.id);
  let again2;
  if (afterFu.body.status === "ACTION_REQUIRED") {
    const qs = afterFu.body.active_request.questions;
    again2 = await respond(
      "rfi-followup-respond-all",
      rfi.id,
      qs.map((q) => ({
        id: q.id,
        answer:
          q.answer.type === "TEXT"
            ? { type: "TEXT", text: "Follow-up answer" }
            : { type: "ATTACHMENT", attachments: [{ file_id: fileId }] },
      })),
    );
    await getRfi("rfi-followup-fetch-after-respond", rfi.id);
  }
  await closeRfi("rfi-check2-close-cleanup", rfi.id);
  const summary = {
    partialTextOnly: { status: partialText.status, body: partialText.body },
    partialAttachmentOnly: { status: partialAtt.status, body: partialAtt.body },
    rfiStatusAfterPartial: afterPartial.body.status,
    secondCreateWhileOpen: { status: oneOpen.status, body: oneOpen.body },
    full: { status: full.status },
    rfiStatusAfterFull: afterFull.body.status,
    respondAgain: { status: again.status, body: again.body },
    followUp: {
      status: fu.status,
      rfiStatusAfter: afterFu.body.status,
      questionCount: afterFu.body.active_request?.questions?.length,
      answeredRequests: afterFu.body.answered_requests?.length,
      respondAfter: again2?.status,
    },
  };
  record("rfi-check2-summary", summary);
  return summary;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await run(), null, 1));
