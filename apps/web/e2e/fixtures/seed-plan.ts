// Seeds the database behind the plan-screen Playwright run (M3-04): the payroll-Friday revision pair from
// the M3-02 fixture (fixtures/planner/payroll-friday.json), stored through the real planner and the real
// plan repository over real obligation, counterparty and payment rows. Nothing is faked in the product
// path; no Airwallex or model call is made.
//
//   npx tsx apps/web/e2e/fixtures/seed-plan.ts users  creates the demo users only
//   npx tsx apps/web/e2e/fixtures/seed-plan.ts seed   stores revisions 1 and 2 (once), prints the ids
//   npx tsx apps/web/e2e/fixtures/seed-plan.ts next   stores one more revision (a changed USD balance)
//
// Needs DATABASE_URL (app role) and the SEED_*_PASSWORD variables; prints ids only, never a secret.
import {
  createDbClientFromEnv,
  getLatestPlan,
  insertPlanRevision,
  repoCtx,
  seedDemoUsers,
} from "@carnet/db";
import { nextRevision, type PlanInputsInput, parseInputs } from "@carnet/domain";
import { seedPlanWorld } from "../../test/plans/plans-world";

const client = createDbClientFromEnv(process.env, { max: 2 });
const db = client.db;

async function main(): Promise<void> {
  const [cmd = "seed"] = process.argv.slice(2);
  const seeded = await seedDemoUsers(db, { env: process.env });
  const rc = repoCtx(db, seeded.businessId);
  if (cmd === "users") return;
  if (cmd === "seed") {
    if (await getLatestPlan(rc)) {
      process.stdout.write(`${JSON.stringify({ seeded: false })}\n`);
      return;
    }
    const world = await seedPlanWorld(db, seeded.businessId);
    process.stdout.write(
      `${JSON.stringify({ seeded: true, paymentId: world.paymentId, obligations: world.obligationIds })}\n`,
    );
    return;
  }
  if (cmd === "next") {
    const latest = await getLatestPlan(rc);
    if (!latest) throw new Error("seed first");
    const inputs = latest.inputs as PlanInputsInput;
    const changed: PlanInputsInput = {
      ...inputs,
      balances: inputs.balances?.map((b) =>
        b.currency === "USD"
          ? { ...b, availableMinor: String(900000 + latest.plan.revision * 1000) }
          : b,
      ),
    };
    const next = nextRevision(latest.plan, changed);
    await insertPlanRevision(rc, next, { inputs: parseInputs(changed), trigger: "e2e" });
    process.stdout.write(`${JSON.stringify({ revision: next.revision })}\n`);
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

try {
  await main();
} finally {
  await client.close();
}
