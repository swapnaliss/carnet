// `npx tsx packages/db/src/seed/run.ts`: seeds the demo business and its three users into the
// database at DATABASE_URL. Needs SEED_OWNER_PASSWORD, SEED_APPROVER_PASSWORD and
// SEED_JUDGE_PASSWORD; exits 1 without them. Prints emails and roles, never a password or hash.
import { createDbClientFromEnv } from "../client";
import { SeedConfigError, seedDemoUsers } from "./demo-users";

async function main(): Promise<number> {
  let client: ReturnType<typeof createDbClientFromEnv> | undefined;
  try {
    client = createDbClientFromEnv(process.env, { max: 1 });
    const result = await seedDemoUsers(client.db, { env: process.env });
    for (const u of result.users) console.log(`seed: ${u.role} ${u.email}`);
    console.log(`seed: business ${result.businessId}, ${result.users.length} users`);
    return 0;
  } catch (error) {
    if (error instanceof SeedConfigError) console.error(error.message);
    else console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    await client?.close();
  }
}

process.exitCode = await main();
