// One live proof (M3-01): every non-scripted case against the real model, recorded, under the spend cap.
//   CRITICALITY_LIVE=1 npx vitest run packages/agent/evals/criticality/live.test.ts
// The key comes from the environment, or from the repository's .env (loaded into the process, never printed).
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertCase } from "./assertions";
import { CASES, runCase } from "./run";

const live = process.env.CRITICALITY_LIVE === "1";
const MAX_USD = 2;

function loadKey(): void {
  if (process.env.ANTHROPIC_API_KEY) return;
  const here = fileURLToPath(new URL("../../../../", import.meta.url));
  for (const dir of [here, process.env.CARNET_ENV_DIR ?? ""]) {
    const file = `${dir}.env`;
    if (dir && existsSync(file)) {
      process.loadEnvFile(file);
      return;
    }
  }
}

describe.skipIf(!live)("criticality live run", () => {
  it("records every case against the real model and passes the same assertions", async () => {
    loadKey();
    expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY is not set").toBeTruthy();
    let nano = 0;
    let inTok = 0;
    let outTok = 0;
    for (const c of CASES.filter((x) => !x.scripted)) {
      const run = await runCase(c, "live");
      await assertCase(run);
      nano += run.result.usage.costNanoUsd;
      inTok += run.result.usage.inputTokens;
      outTok += run.result.usage.outputTokens;
      console.log(
        `live ${c.id}: ${run.result.verifierResult}${run.result.verifierResult === "REJECTED" ? ` (${run.result.reason})` : ""}`,
      );
    }
    console.log(`live total: in=${inTok} out=${outTok} usd=${(nano / 1e9).toFixed(4)}`);
    expect(nano / 1e9).toBeLessThanOrEqual(MAX_USD);
  }, 600_000);
});
