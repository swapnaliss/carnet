// `npm run test -w packages/db`: unit tests plus the integration tests against Docker Postgres.
// Needs DATABASE_MIGRATION_URL and DATABASE_URL pointing at a local Postgres prepared by
// sql/roles.sql (docker compose does this on a fresh volume). Files run in parallel workers, each on
// its own database (test/harness.ts).
import { defineConfig } from "vitest/config";
import ConcurrencyFirstSequencer from "./test/sequencer";

export default defineConfig({
  test: {
    name: "db",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    // Starts concurrency-a/b together on two workers (test/sequencer.ts).
    sequence: { sequencer: ConcurrencyFirstSequencer },
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
