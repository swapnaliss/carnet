// JSON parsing that keeps every number's source text. Airwallex sends amounts as JSON numbers in
// major units ("amount_payer_pays": 43.41); going through a float would risk a wrong minor-unit
// value (BL-01 6625668304). The reviver's `context.source` (JSON.parse source text access, Node 21+)
// gives the exact digits, which `parseMajor` turns into integer minor units.

/** A JSON number as it appeared in the body. */
export class WireNumber {
  readonly source: string;
  constructor(source: string) {
    this.source = source;
  }
  toNumber(): number {
    return Number(this.source);
  }
  toJSON(): number {
    return Number(this.source);
  }
}

export function parseJsonPreservingNumbers(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" ? new WireNumber(context?.source ?? String(value)) : value,
  );
}
