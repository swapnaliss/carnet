import { defineConfig } from "vitest/config";

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
if (!hasDb) {
  console.warn("vitest: TEST_DATABASE_URL is not set; the integration project is skipped.");
}
// packages/db runs its own integration project (per-worker databases, packages/db/vitest.config.ts)
// and needs the app and migration role URLs of a local Postgres prepared by sql/roles.sql.
const hasDbRoles = Boolean(process.env.DATABASE_URL && process.env.DATABASE_MIGRATION_URL);
if (!hasDbRoles) {
  console.warn(
    "vitest: DATABASE_URL and DATABASE_MIGRATION_URL are not both set; the packages/db integration tests are skipped.",
  );
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "packages/*/src/**/*.test.ts",
            "packages/*/test/**/*.test.ts",
            "apps/*/src/**/*.test.ts",
            "apps/*/test/**/*.test.ts",
          ],
          // apps/web/test/auth needs the same local Postgres roles as packages/db (M1-04).
          exclude: [
            "**/*.int.test.ts",
            "**/node_modules/**",
            ...(hasDbRoles ? [] : ["apps/web/test/auth/**"]),
          ],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: "integration",
          include: hasDb ? ["packages/*/test/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"] : [],
          exclude: ["packages/db/test/**", "**/node_modules/**"],
          passWithNoTests: true,
        },
      },
      ...(hasDbRoles
        ? [
            {
              extends: "./packages/db/vitest.config.ts",
              test: {
                name: "db",
                root: "./packages/db",
                include: ["test/**/*.int.test.ts"],
                // Its own maxWorkers needs its own group; it runs after the other projects.
                sequence: { groupOrder: 1 },
              },
            },
          ]
        : []),
    ],
  },
});
