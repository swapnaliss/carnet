import { defineConfig, devices } from "@playwright/test";

// End-to-end checks run against the production build (`next build` first, then `next start`), never
// the dev server: accessibility and Core Web Vitals are measured on what ships.
// PORT_OFFSET keeps parallel worktrees off each other's ports.
const port = 3000 + Number(process.env.PORT_OFFSET ?? 0);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: {
    command: `npm run start -w @carnet/web -- --port ${port}`,
    url: `${baseURL}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
