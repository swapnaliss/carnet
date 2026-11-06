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

/**
 * Parts of a zod schema the API's decoder cannot honour (docs/evidence/anthropic-spike.md): a
 * `z.record` becomes an object with no properties, so the model can only return `{}`. Returns the
 * path of every such object; a prompt's test asserts it is empty (BL-01).
 */
export function schemaSubsetViolations(schema: z.ZodType): string[] {
  const found: string[] = [];
  const walk = (node: unknown, path: string): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const props = n.properties as Record<string, unknown> | undefined;
    if (n.type === "object" && (!props || Object.keys(props).length === 0)) found.push(path || "/");
    for (const [k, v] of Object.entries(props ?? {})) walk(v, `${path}/${k}`);
    walk(n.items, `${path}/[]`);
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const list = n[key];
      if (Array.isArray(list)) list.forEach((c, i) => walk(c, `${path}/${key}${i}`));
    }
  };
  walk(jsonSchemaOf(schema), "");
  return found;
}
