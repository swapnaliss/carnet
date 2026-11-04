import { defineConfig } from "vitest/config";

// `npm run test -w apps/web`: this workspace's unit tests. The root config runs the same files.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: ["**/*.int.test.ts", "**/node_modules/**", "e2e/**"],
  },
});
