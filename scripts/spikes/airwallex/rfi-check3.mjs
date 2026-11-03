import { record, requireEnv } from "./lib.mjs";
import {
  closeAllOpenRfis,
  closeRfi,
  createRfi,
  freshTransfer,
  getRfi,
  JPEG,
  PDF,
  PNG,
  question,
  respond,
  upload,
} from "./rfi-lib.mjs";

requireEnv();

// Check 3: PNG, oversized, PDF, JPEG: which pass upload, which pass respond.
export async function run() {
  const out = {};
  const t = await freshTransfer("rfi-check3-transfer-create");
  const over = Buffer.alloc(21 * 1024 * 1024, 0x20);
  over.write("%PDF-1.4\n");
  const files = [
    ["png", PNG, "evidence.png", "image/png"],
    ["pdf", PDF, "evidence.pdf", "application/pdf"],
    ["jpeg", JPEG, "evidence.jpg", "image/jpeg"],
    ["oversized-21mb-pdf", over, "big.pdf", "application/pdf"],
    ["txt", Buffer.from("plain text evidence"), "evidence.txt", "text/plain"],
  ];
  for (const [label, bytes, filename, mime] of files) {
    const up = await upload(`rfi-check3-upload-${label}`, bytes, filename, mime);
    const entry = {
      bytes: bytes.length,
      upload: { status: up.status, body: up.status < 300 ? { file_id: "<id>" } : up.body },
    };
    if (up.status < 300) {
      await closeAllOpenRfis();
      const c = await createRfi(`tmp-c-${label}`, {
        transferIds: [t.id],
        questions: [question("ATTACHMENT", `Evidence ${label}`)],
      });
      const q = c.body.active_request.questions[0];
      const r = await respond(`rfi-check3-respond-${label}`, c.body.id, [
        { id: q.id, answer: { type: "ATTACHMENT", attachments: [{ file_id: up.body.file_id }] } },
      ]);
      const g = await getRfi(`rfi-check3-fetch-${label}`, c.body.id);
      entry.respond = {
        status: r.status,
        body: r.status < 300 ? "ok" : r.body,
        rfiStatusAfter: g.body.status,
      };
      await closeRfi(`tmp-close-${label}`, c.body.id);
    }
    out[label] = entry;
  }
  record("rfi-check3-summary", out);
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await run(), null, 1));
