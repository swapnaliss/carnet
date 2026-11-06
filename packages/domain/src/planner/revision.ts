// Immutable plan revisions (M3-02). A revision is identified by the hash of everything that went into
// it. `nextRevision` is pure: the same inputs return the previous plan object itself, changed inputs
// return revision + 1. Storing is the repository's job (insert only).
import { contentHash, decide, sequence } from "./plan";
import {
  type Plan,
  type PlanInputs,
  type PlanInputsInput,
  PlanInputsSchema,
  PlanSchema,
} from "./schemas";
import { canonicalJson, sha256Hex } from "./sha256";

/** Validate and normalise inputs; throws a ZodError naming the bad field. */
export function parseInputs(raw: PlanInputsInput): PlanInputs {
  return PlanInputsSchema.parse(raw);
}

/** SHA-256 of the canonical JSON of the normalised inputs (config and `now` included). */
export function inputsHash(inputs: PlanInputs): string {
  return sha256Hex(canonicalJson(inputs));
}

function build(inputs: PlanInputs, revision: number, hash: string): Plan {
  const actions = sequence(decide(inputs));
  return {
    schema_version: 1,
    business_id: inputs.businessId,
    revision,
    inputs_hash: hash,
    content_hash: contentHash(inputs, actions),
    now: inputs.now,
    policy: { version: inputs.policy.version, hash: inputs.policy.hash },
    held_funds_visible_in_balances: inputs.config.heldFundsVisibleInBalances,
    actions,
  };
}

/** The plan for `raw` as revision 1. */
export function plan(raw: PlanInputsInput): Plan {
  const inputs = parseInputs(raw);
  return build(inputs, 1, inputsHash(inputs));
}

/**
 * The plan after `previous` (the business's latest stored revision, or null) for new inputs: the
 * very same object when nothing changed, otherwise a plan with `revision + 1`.
 */
export function nextRevision(previous: Plan | null, raw: PlanInputsInput): Plan {
  const inputs = parseInputs(raw);
  if (previous && previous.business_id !== inputs.businessId) {
    throw new Error("nextRevision: the previous plan belongs to another business");
  }
  const hash = inputsHash(inputs);
  if (previous && previous.inputs_hash === hash) return previous;
  return build(inputs, previous ? previous.revision + 1 : 1, hash);
}

/** Parse a plan from JSON (a stored or transmitted plan); throws if it is not a valid plan. */
export function parsePlan(value: unknown): Plan {
  return PlanSchema.parse(value);
}
