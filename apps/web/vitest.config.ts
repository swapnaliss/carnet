import { defineConfig } from "vitest/config";

// `npm run test -w apps/web`: this workspace's unit tests. The root config runs the same files.
// test/auth/** runs against a local Postgres through the packages/db harness (one database per
// worker), so it needs DATABASE_URL and DATABASE_MIGRATION_URL; without them it is skipped loudly.
const hasDbRoles = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
if (!hasDbRoles) {
  console.warn(
    "vitest (apps/web): DATABASE_URL and DATABASE_MIGRATION_URL are not both set; test/auth is skipped.",
  );
}

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      "**/*.int.test.ts",
      "**/node_modules/**",
      "e2e/**",
      ...(hasDbRoles ? [] : ["test/auth/**"]),
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
