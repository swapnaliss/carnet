// Retry delay for failed outbox jobs (ADR 0005): exponential with "equal jitter", so the delay for
// attempt n lies in [cap/2, cap] with cap = min(max, base * 2^(n-1)). The lower bound of attempt n+1
// equals the upper bound of attempt n, so `run_after` grows with every failure while workers that
// failed together still spread out.

export const DEFAULT_BACKOFF_BASE_MS = 1_000;
export const DEFAULT_BACKOFF_MAX_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_ATTEMPTS = 8;

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  random?: () => number;
}

/** Delay before the next try after `attempt` failed attempts (attempt starts at 1). */
export function retryDelayMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const max = options.maxMs ?? DEFAULT_BACKOFF_MAX_MS;
  const random = options.random ?? Math.random;
  const n = Math.max(1, Math.floor(attempt));
  const cap = Math.min(max, base * 2 ** Math.min(n - 1, 30));
  const half = cap / 2;
  return Math.round(half + random() * half);
}
