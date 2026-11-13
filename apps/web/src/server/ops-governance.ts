// What the /ops governance panel shows (M4-02): the two switches with who changed them last, model
// spend against the caps, and the circuit-breaker state of each dependency. Everything is read from
// the database on each request; nothing is cached.
import {
  type BreakerView,
  breakerConfigFromEnv,
  capToNanoUsd,
  type Db,
  getSystemFlags,
  lastSwitchChanges,
  listUsers,
  readBreakers,
  repoCtx,
  type SpendSummary,
  type SwitchChange,
  spendSummary,
} from "@carnet/db";

export interface GovernanceView {
  readonly agentsEnabled: boolean;
  readonly executionEnabled: boolean;
  readonly agentsChange: SwitchChange | null;
  readonly executionChange: SwitchChange | null;
  readonly dailyCapNanoUsd: number;
  readonly perRunCapNanoUsd: number;
  readonly spend: SpendSummary;
  readonly breakers: BreakerView[];
  /** user id to display name (or email), for "changed by". */
  readonly names: Map<string, string>;
}

export async function loadGovernance(
  db: Db,
  businessId: string,
  now: Date = new Date(),
): Promise<GovernanceView> {
  const rc = repoCtx(db, businessId as Parameters<typeof repoCtx>[1]);
  const [flags, changes, spend, breakers, users] = await Promise.all([
    getSystemFlags(db),
    lastSwitchChanges(rc),
    spendSummary(rc, now),
    readBreakers(db, breakerConfigFromEnv(), now),
    listUsers(rc),
  ]);
  return {
    agentsEnabled: flags.agentsEnabled,
    executionEnabled: flags.executionEnabled,
    agentsChange: changes.agents_enabled ?? null,
    executionChange: changes.execution_enabled ?? null,
    dailyCapNanoUsd: capToNanoUsd(flags.dailySpendCap),
    perRunCapNanoUsd: capToNanoUsd(flags.perRunCap),
    spend,
    breakers,
    names: new Map(users.map((u) => [u.id as string, u.name ?? u.email])),
  };
}
