import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { apiFor, expectPayeeHeaders, expectPlanScreen, readPayeePage } from "./demo-support";

// The M3-07 demo, CI REPLAY variant: no network, nothing live. Only with E2E_MODE=replay.
//
// It runs the same UI assertions as demo-live.spec.ts (the shared helpers in demo-support.ts) against a
// database seeded with the payroll-Friday revision pair through the real planner and real rows
// (apps/web/e2e/fixtures/seed-plan.ts, as plan-screen.spec.ts does): the plan screen at its latest
// revision, and the payee's public page (headers, status-only wording) through a link the owner creates.
// It does NOT cover the plan inputs loader or the re-run triggers (ADR 0021; apps/web/test/worker/plan-inputs.int.test.ts
// does), nor how revisions are numbered in a live run, nor what needs Airwallex or the model (the sandbox transfers, the RFI, the conversion and
// payout executing, the follow-up round): those are the live spec's and docs/evidence/m3-run.md.
// The recorded fixtures/replay/m3 are served by the judge replay mode (M4-05), not read here.
// Needs DATABASE_URL, SEED_*_PASSWORD and the web server on the same database; otherwise skipped loudly.
test.skip(
  process.env.E2E_MODE !== "replay",
  "demo replay: set E2E_MODE=replay (live: demo-live.spec.ts).",
);
test.skip(
  !process.env.SEED_OWNER_PASSWORD || !process.env.SEED_JUDGE_PASSWORD || !process.env.DATABASE_URL,
  "DATABASE_URL and SEED_*_PASSWORD are not set; the demo replay is skipped.",
);
test.describe.configure({ mode: "serial" });

const seed = (cmd: string) =>
  execFileSync("npx", ["tsx", "apps/web/e2e/fixtures/seed-plan.ts", cmd], {
    encoding: "utf8",
    env: process.env,
    timeout: 120_000,
  })
    .trim()
    .split("\n")
    .at(-1) as string;

test("the plan screen shows the latest revision and the payee page shows status wording only", async ({
  page,
}) => {
  test.setTimeout(150_000);
  seed("users");
  const seeded = JSON.parse(seed("seed")) as { seeded: boolean; paymentId?: string };
  const signIn = await page.request.post("/api/auth/sign-in/email", {
    data: { email: "owner@carnet.example", password: process.env.SEED_OWNER_PASSWORD },
  });
  expect(signIn.status(), await signIn.text()).toBe(200);
  const api = apiFor(() => page);

  // Steps 1 and 6 of the live spec: the plan screen at the latest revision (a database that already holds
  // more revisions from another spec is read as it is).
  const plan = await api.call<{ plan: { revision: number } | null }>(
    "GET",
    "/api/v1/plans/current",
  );
  expect(plan.body.plan, "no plan stored").toBeTruthy();
  await expectPlanScreen(page, plan.body.plan?.revision ?? 0);
  await expect(page.getByTestId("plan-trigger")).toBeVisible();

  // Step 9: the payee page, for the payment the seed created or the first payment on file.
  const paymentId = seeded.paymentId ?? (await firstPaymentId(api));
  const link = await api.call<{ path: string | null }>(
    "POST",
    `/api/v1/payments/${paymentId}/payee-links`,
    { disclosure_level: "GENERIC" },
    { "idempotency-key": `replay-${Date.now()}-generic` },
  );
  expect(link.status, JSON.stringify(link.body)).toBe(201);
  const read = await readPayeePage(page, `${new URL(page.url()).origin}${link.body.path}`);
  expect(read.status).toBe(200);
  expectPayeeHeaders(read.headers);
  expect(read.text).toMatch(/Payment status/);
  expect(read.text).not.toContain("Delayed for verification");
  for (const leak of ["Nordlicht", "INV-NORDLICHT", "2,500", "Carnet"]) {
    expect(read.text, leak).not.toContain(leak);
  }
});

async function firstPaymentId(api: ReturnType<typeof apiFor>): Promise<string> {
  const r = await api.call<{ items: { id: string }[] }>("GET", "/api/v1/payments");
  const id = r.body.items?.[0]?.id;
  if (!id) throw new Error("no payment to make a link for");
  return id;
}
