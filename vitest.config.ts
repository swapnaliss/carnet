import { defineConfig } from "vitest/config";

const hasDb = Boolean(process.env.TEST_DATABASE_URL);
if (!hasDb) {
  console.warn("vitest: TEST_DATABASE_URL is not set; the integration project is skipped.");
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
          ],
          exclude: ["**/*.int.test.ts", "**/node_modules/**"],
        },
      },
      {
        test: {
          name: "integration",
          include: hasDb ? ["packages/*/test/**/*.int.test.ts", "apps/*/src/**/*.int.test.ts"] : [],
          passWithNoTests: true,
        },
      },
    ],
  },
});
