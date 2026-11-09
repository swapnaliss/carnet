// Canonical JSON for approval hashing (ADR 0008, M2-07). Deterministic by construction: object keys
// sorted (code-unit order), no insignificant whitespace, every string (keys included) in Unicode NFC,
// and integers only (a float, NaN, bigint or undefined is a programming error, never silently coerced).
// Pure; no I/O.

export class CanonicalJsonError extends Error {
  readonly code = "CANONICAL_JSON";
  constructor(message: string) {
    super(`approval canonical JSON: ${message}`);
    this.name = "CanonicalJsonError";
  }
}

const nfc = (s: string): string => s.normalize("NFC");

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(nfc(value));
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isSafeInteger(value)) throw new CanonicalJsonError(`${path}: not a safe integer`);
      return String(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(",")}]`;
      }
      const seen = new Set<string>();
      const entries: [string, unknown][] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v === undefined) throw new CanonicalJsonError(`${path}.${k}: undefined`);
        const key = nfc(k);
        if (seen.has(key)) throw new CanonicalJsonError(`${path}.${k}: duplicate key`);
        seen.add(key);
        entries.push([key, v]);
      }
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`${path}: unsupported ${typeof value}`);
  }
}

/** The canonical serialisation of `value` (see the header for the rules). */
export function approvalCanonicalJson(value: unknown): string {
  return encode(value, "$");
}
