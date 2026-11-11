// Seeds the database behind the follow-up Playwright run (M3-05) with REAL pipeline output over recorded
// responses (see apps/web/test/follow-up-support.ts): a counterparty whose round 1 answers were approved
// and remembered, and three follow-up RFIs drafted by the real `rfi.draft` handler.
//
//   npx tsx apps/web/e2e/fixtures/seed-follow-up.ts      prints { name: { id } }
//
// Needs DATABASE_URL (app role) and the SEED_*_PASSWORD variables; prints ids only, never a secret.
import { createDbClientFromEnv, repoCtx, seedDemoUsers } from "@carnet/db";
import {
  countingTransport,
  endUseAppended,
  loadEvidence,
  purposeReopened,
  recordedReply,
  runDraftJob,
  SET,
  seedApprovedRound1,
  seedFollowUpRfi,
} from "../../test/follow-up-support";

const client = createDbClientFromEnv(process.env, { max: 2 });
const db = client.db;

try {
  const { businessId } = await seedDemoUsers(db, { env: process.env });
  const ev = await loadEvidence(repoCtx(db, businessId));
  const origin = await seedApprovedRound1(db, businessId, ev);
  const out: Record<string, { id: string }> = {};

  // 1. Everything reused: no model call at all; one click applies it.
  const reused = await seedFollowUpRfi(db, origin, [purposeReopened()], "RD-FU-1");
  const none = countingTransport(async () => {
    throw new Error("the model must not be called for a fully reused round");
  });
  await runDraftJob(db, businessId, reused.rfiId, 2, none.transport);
  out.reused = { id: reused.rfiId };

  // 2. One reopened question reused, one appended question the model could not ground: blocked.
  const mixed = await seedFollowUpRfi(db, origin, [purposeReopened(), endUseAppended()], "RD-FU-2");
  await runDraftJob(db, businessId, mixed.rfiId, 2, recordedReply(`${SET}-r2`, ev, mixed.qIds));
  out.mixed = { id: mixed.rfiId };

  // 3. The reopened question's wording changed: a new model draft and a diff of the two wordings.
  const changed = await seedFollowUpRfi(
    db,
    origin,
    [
      {
        ...purposeReopened(),
        description: "Describe what this payment is for and the goods it covers.",
      },
    ],
    "RD-FU-3",
  );
  await runDraftJob(db, businessId, changed.rfiId, 2, recordedReply(`${SET}-r1`, ev, changed.qIds));
  out.changed = { id: changed.rfiId };

  process.stdout.write(`${JSON.stringify(out)}\n`);
} finally {
  await client.close();
}
