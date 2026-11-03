import { record, requireEnv } from "./lib.mjs";
import { closeAllOpenRfis, createRfi, freshTransfer, question, respond } from "./rfi-lib.mjs";

requireEnv();

// Check 6: TEXT answer length limit by bisection.
export async function run() {
  await closeAllOpenRfis();
  const t = await freshTransfer("rfi-check6-transfer-create");
  const log = [];
  let lastError;
  const attempt = async (n) => {
    await closeAllOpenRfis();
    const c = await createRfi("tmp-c6", {
      transferIds: [t.id],
      questions: [question("TEXT", "Long?")],
    });
    const r = await respond("tmp-r6", c.body.id, [
      { id: c.body.active_request.questions[0].id, answer: { type: "TEXT", text: "a".repeat(n) } },
    ]);
    const ok = r.status < 300;
    log.push({ length: n, status: r.status });
    if (!ok) lastError = { length: n, status: r.status, body: r.body };
    return ok;
  };
  let lo = 0;
  let hi;
  for (const n of [
    1000, 10_000, 100_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000, 20_000_000,
  ]) {
    if (await attempt(n)) lo = n;
    else {
      hi = n;
      break;
    }
  }
  if (hi) {
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      if (await attempt(mid)) lo = mid;
      else hi = mid;
    }
  }
  const out = {
    largestAccepted: lo,
    smallestRejected: hi ?? null,
    error: lastError ?? null,
    attempts: log.length,
    log,
  };
  record("rfi-check6-summary", out);
  await closeAllOpenRfis();
  return out;
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const o = await run();
  delete o.log;
  console.log(JSON.stringify(o, null, 1));
}
