import { defineConfig, devices } from "@playwright/test";

// End-to-end checks run against the production build (`next build` first, then `next start`), never
// the dev server: accessibility and Core Web Vitals are measured on what ships.
// PORT_OFFSET keeps parallel worktrees off each other's ports.
const port = 3000 + Number(process.env.PORT_OFFSET ?? 0);
// E2E_BASE_URL points the run at a deployed origin (M1-08, BL-01 6625891576); no local server then.
const deployed = process.env.E2E_BASE_URL;
const baseURL = deployed ?? `http://localhost:${port}`;
// CI runs the e2e suite in two phases around `demo:reset` (BL-01). Before it, no recording is loaded
// and the judge (the only viewer) reads the live demo business, which the viewer read-only specs use.
// After it, the judge is in replay (M4-05), which these specs check. E2E_PHASE=before-replay skips them.
const REPLAY_SPECS = ["**/replay.spec.ts", "**/ops-audit.spec.ts", "**/a11y/axe.spec.ts"];

export default defineConfig({
  testDir: "apps/web/e2e",
  ...(process.env.E2E_PHASE === "before-replay" ? { testIgnore: REPLAY_SPECS } : {}),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  timeout: 30_000,
  use: { baseURL, ...devices["Desktop Chrome"] },
  webServer: deployed
    ? undefined
    : {
        command: `npm run start -w @carnet/web -- --port ${port}`,
        // Turns on /error-preview so the page-level error state is checked like every other page.
        env: { CARNET_ERROR_PREVIEW: "1" },
        // Readiness is the home page: /healthz is 503 when no database is configured (M1-06).
        url: `${baseURL}/`,
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: "ignore",
        stderr: "pipe",
      },
});
