// /healthz (ADR 0014): 200 with {status, version, db} after a cheap `SELECT 1`, 503 when the database
// is unreachable or not configured. The platform health check and the deploy gate read this.

export type DbHealth = "ok" | "unreachable" | "unconfigured";

export interface HealthPayload {
  status: "ok" | "unavailable";
  version: string;
  db: DbHealth;
  time: string;
}

/** The deployed version: the build's commit (Render sets RENDER_GIT_COMMIT), else APP_VERSION, else "dev". */
export function appVersion(env: Record<string, string | undefined> = process.env): string {
  const commit = env.RENDER_GIT_COMMIT ?? env.APP_VERSION;
  return commit ? commit.slice(0, 12) : "dev";
}

/** Runs `ping` with a deadline; any error or timeout counts as unreachable. */
export async function probeDb(
  ping: (() => Promise<unknown>) | null,
  timeoutMs = 2_000,
): Promise<DbHealth> {
  if (!ping) return "unconfigured";
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("db ping timed out")), timeoutMs);
  });
  try {
    await Promise.race([ping(), deadline]);
    return "ok";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export function healthPayload(
  db: DbHealth,
  version: string,
  now: Date = new Date(),
): { httpStatus: 200 | 503; body: HealthPayload } {
  const ok = db === "ok";
  return {
    httpStatus: ok ? 200 : 503,
    body: { status: ok ? "ok" : "unavailable", version, db, time: now.toISOString() },
  };
}
