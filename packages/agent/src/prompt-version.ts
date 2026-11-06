// Prompt versioning. A prompt is a module exporting its system text and its zod schema; its version is
// the first 12 hex characters of SHA-256 over the exact system text sent (the caller's text plus the
// untrusted-data rule) and the JSON schema sent to the API. Changing one character of either changes
// the version; steps record it, and replay matches on it.
import { createHash } from "node:crypto";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { composeSystem } from "./guardrail";

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The JSON schema the API receives for this zod schema. */
export function jsonSchemaOf(schema: z.ZodType): unknown {
  return zodOutputFormat(schema).schema;
}

export function promptVersion(system: string, schema: z.ZodType): string {
  const material = `${composeSystem(system)}\n\u0000\n${canonicalJson(jsonSchemaOf(schema))}`;
  return sha256Hex(material).slice(0, 12);
}
