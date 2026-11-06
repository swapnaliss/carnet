// Stored-output replay (architecture §10). Every successful call stores its parsed output with the
// (run kind, ref, step, input hash, prompt version) that produced it. Before calling, the harness looks
// that key up; a hit returns the stored output with `replayed: true` and no network call. A run that
// crashed after the model replied, but before the caller used the result, therefore replays and never
// spends twice.
import type { z } from "zod";
import { canonicalJson, sha256Hex } from "./prompt-version";
import type { HarnessStore, ReplayKey } from "./store";
import type { ModelBlock } from "./structured";

/** SHA-256 (hex) of the model and the exact content blocks sent. */
export function inputHash(model: string, blocks: readonly ModelBlock[]): string {
  return sha256Hex(canonicalJson({ model, blocks }));
}

export interface ReplayHit<T> {
  readonly stepId: string;
  readonly output: T;
}

/**
 * The stored output for `key`, validated against `schema` again. A stored output that no longer
 * parses (it cannot, unless the row was edited, since the schema is part of the prompt version) is
 * ignored and the call goes to the model.
 */
export async function lookupReplay<S extends z.ZodType>(
  store: HarnessStore,
  key: ReplayKey,
  schema: S,
): Promise<ReplayHit<z.infer<S>> | null> {
  const stored = await store.findReplayableStep(key);
  if (!stored) return null;
  const parsed = schema.safeParse(stored.output);
  return parsed.success ? { stepId: stored.id, output: parsed.data as z.infer<S> } : null;
}
