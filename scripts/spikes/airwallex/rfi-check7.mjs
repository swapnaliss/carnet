import { record, requireEnv } from "./lib.mjs";
import { closeAllOpenRfis, createRfi, freshTransfer, getRfi, question } from "./rfi-lib.mjs";

requireEnv();

const srcOf = (rfi) =>
  rfi.active_request.questions.map((q) => ({ title: q.title.en, sources: q.sources ?? null }));

// Check 7: sources on the created and fetched RFI; several sources; none; and whether the one-open rule is per source.
export async function run() {
  await closeAllOpenRfis();
  const a = await freshTransfer("rfi-check7-transfer-a", 20);
  const b = await freshTransfer("rfi-check7-transfer-b", 21);
  const out = {};
  const multi = await createRfi("rfi-check7-create-multi-source", {
    transferIds: [a.id, b.id],
    questions: [question("TEXT", "Both payments?")],
  });
  out.multi = {
    status: multi.status,
    createdSources: multi.status < 300 ? srcOf(multi.body) : multi.body,
  };
  if (multi.status < 300)
    out.multi.fetchedSources = srcOf((await getRfi("rfi-check7-fetch-multi", multi.body.id)).body);
  // second RFI on a different source while the first is open
  const diff = await createRfi("rfi-check7-create-other-source-while-open", {
    transferIds: [],
    questions: [question("TEXT", "No source question")],
  });
  out.openRuleOtherSource = {
    status: diff.status,
    body: diff.status < 300 ? "created" : diff.body,
  };
  const diff2 = await createRfi("rfi-check7-create-only-b-while-open", {
    transferIds: [b.id],
    questions: [question("TEXT", "B only")],
  });
  out.openRuleOverlappingSource = {
    status: diff2.status,
    body: diff2.status < 300 ? "created" : diff2.body,
  };
  await closeAllOpenRfis();
  const none = await createRfi("rfi-check7-create-no-sources", {
    transferIds: [],
    questions: [question("TEXT", "Orphan question")],
  });
  out.none = {
    status: none.status,
    createdSources: none.status < 300 ? srcOf(none.body) : none.body,
  };
  if (none.status < 300)
    out.none.fetchedSources = srcOf(
      (await getRfi("rfi-check7-fetch-no-sources", none.body.id)).body,
    );
  // different sources per question
  await closeAllOpenRfis();
  const mixed = await (await import("./lib.mjs")).call(
    "rfi-check7-create-per-question-sources",
    "POST",
    "/api/v1/simulation/rfis/create",
    {
      body: {
        type: "TRANSACTION",
        questions: [
          { ...question("TEXT", "About A"), sources: [{ id: a.id, type: "TRANSFER" }] },
          { ...question("TEXT", "About B"), sources: [{ id: b.id, type: "TRANSFER" }] },
        ],
      },
    },
  );
  out.perQuestion = {
    status: mixed.status,
    createdSources: mixed.status < 300 ? srcOf(mixed.body) : mixed.body,
  };
  await closeAllOpenRfis();
  record("rfi-check7-summary", out);
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`)
  console.log(JSON.stringify(await run(), null, 1));
