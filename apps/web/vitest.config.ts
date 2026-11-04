import { defineConfig } from "vitest/config";

// `npm run test -w apps/web`: this workspace's unit tests, plus the database-backed tests
// (`test/**/*.int.test.ts`: webhook route, worker loop, handlers, reconcile) when DATABASE_URL and
// DATABASE_MIGRATION_URL point at a local Postgres prepared by packages/db/sql/roles.sql. Each test
// file gets its own `carnet_test_web_<worker>` database (packages/db/test/harness.ts).
const hasDbRoles = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
if (!hasDbRoles) {
  console.warn(
    "vitest (apps/web): DATABASE_URL and DATABASE_MIGRATION_URL are not both set; the database-backed tests are skipped.",
  );
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      ...(hasDbRoles ? [] : ["**/*.int.test.ts"]),
      "src/**/*.int.test.ts",
      "**/node_modules/**",
      "e2e/**",
    ],
    // Keeps info lines (one per webhook and job) out of the test output; warn and error still show.
    env: { LOG_LEVEL: "warn" },
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
