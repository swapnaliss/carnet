// `npx vitest run --config packages/agent/vitest.evals.config.ts <path>`: the eval suites, which run on
// recorded responses (no network, no spend). Live runs are the separate *.live tests.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "agent-evals",
    include: ["packages/agent/evals/**/*.eval.test.ts"],
    testTimeout: 60_000,
    // Names every case, also when output is piped: the gate greps the log for the injection cases.
    reporters: ["verbose"],
  },
});
