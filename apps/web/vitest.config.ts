import { defineConfig } from "vitest/config";

// `npm run test -w apps/web`: this workspace's unit tests, plus the tests that need a local Postgres
// prepared by packages/db/sql/roles.sql (DATABASE_URL and DATABASE_MIGRATION_URL): test/auth/**
// (M1-04) and test/**/*.int.test.ts (M1-05: webhook route, worker loop, handlers, reconcile). Each
// gets its own database per worker through the packages/db harness. Without the URLs they are
// skipped loudly.
const hasDbRoles = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
if (!hasDbRoles) {
  console.warn(
    "vitest (apps/web): DATABASE_URL and DATABASE_MIGRATION_URL are not both set; test/auth and the *.int.test.ts files are skipped.",
  );
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      ...(hasDbRoles ? [] : ["**/*.int.test.ts", "test/auth/**"]),
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
