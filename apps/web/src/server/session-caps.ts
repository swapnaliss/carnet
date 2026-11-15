// Per-session caps (M4-05). Config values, read on each call:
//   SESSION_MODEL_CAP_USD   model spend one web session may cause, default 1.00 USD. Checked twice:
//                           at the routes that queue model work (429 SESSION_MODEL_CAP, nothing queued)
//                           and in the agent harness before every call (with the per-run and daily caps,
//                           M4-02), because a queued job can still cross it.
//   UPLOAD_MAX_BYTES        per file (413), and UPLOAD_SESSION_MAX_FILES files per session (429): the M2-01
//                           upload caps, server/documents/limits.ts.
// Every counter is in the database (agent_runs.session_id, rate_limits), so a restart keeps it.
import { type Db, sessionModelSpendNanoUsd } from "@carnet/db";
import { HttpProblem } from "../lib/errors";

export const DEFAULT_SESSION_MODEL_CAP_USD = 1;
const NANO_PER_USD = 1_000_000_000;

export function sessionModelCapNanoUsd(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.SESSION_MODEL_CAP_USD;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  const usd = Number.isFinite(n) && n >= 0 ? n : DEFAULT_SESSION_MODEL_CAP_USD;
  return Math.round(usd * NANO_PER_USD);
}

/** `details.cap` of the 429 (code RATE_LIMITED) a route answers when the session's budget is spent. */
export const SESSION_MODEL_CAP = "session_model_spend";
export const SESSION_MODEL_CAP_MESSAGE =
  "This session has used its model budget (SESSION_MODEL_CAP_USD). Nothing was queued.";

export function sessionModelCapExceeded(): HttpProblem {
  return new HttpProblem("RATE_LIMITED", SESSION_MODEL_CAP_MESSAGE, {
    details: { cap: SESSION_MODEL_CAP },
  });
}

/** Throws 429 when the session's model spend has reached its cap. A missing session id is not capped. */
export async function assertSessionModelBudget(
  db: Db,
  sessionId: string | undefined,
  env: Record<string, string | undefined> = process.env,
): Promise<void> {
  if (!sessionId) return;
  const spent = await sessionModelSpendNanoUsd(db, sessionId);
  if (spent >= sessionModelCapNanoUsd(env)) throw sessionModelCapExceeded();
}

/** The worker side: the attribution a job payload carries (`sessionId`), with the cap from env. */
export function sessionAttribution(
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
): { sessionId: string; capNanoUsd: number } | null {
  const sessionId =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>).sessionId
      : undefined;
  return typeof sessionId === "string" && sessionId.length > 0
    ? { sessionId, capNanoUsd: sessionModelCapNanoUsd(env) }
    : null;
}
