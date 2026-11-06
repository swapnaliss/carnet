// Test prompts: the schemas the M0-06 spike recorded its fixtures with (scripts/spikes/anthropic/run.mjs),
// as prompt modules (system text + schema + version), the shape M2-02 and M2-05 follow.
import { z } from "zod";
import type { ModelBlock } from "../src/index";
import { promptVersion, wrapUntrusted } from "../src/index";

export const Draft = z.object({
  status: z.enum(["ANSWER", "NEEDS_OWNER"]),
  answer: z.string(),
  citations: z.array(z.object({ document_id: z.string(), field: z.string(), quote: z.string() })),
  missing_evidence: z.array(z.string()),
});

export const Extraction = z.object({
  document_kind: z.enum([
    "invoice",
    "contract",
    "purchase_order",
    "delivery_note",
    "funds_evidence",
    "other",
  ]),
  text_readable: z.boolean(),
  facts: z.array(
    z.object({
      field: z.string(),
      value: z.string(),
      quote: z.string().nullable(),
      page: z.number().int(),
    }),
  ),
  embedded_instructions: z.array(z.string()),
});

export const DRAFT_SYSTEM =
  "You draft an answer to one compliance question from extracted document facts. Cite facts verbatim. If the facts do not answer the question, return NEEDS_OWNER with what is missing.";
export const DRAFT_VERSION = promptVersion(DRAFT_SYSTEM, Draft);

export const EXTRACT_SYSTEM =
  "You extract facts from one business document for a payment-compliance file. For each requested field give value, a verbatim quote and the 1-based page.";
export const EXTRACT_VERSION = promptVersion(EXTRACT_SYSTEM, Extraction);

export function draftBlocks(question: string): ModelBlock[] {
  return [
    { type: "text", text: wrapUntrusted("rfi-question", question) },
    {
      type: "text",
      text: wrapUntrusted(
        "facts",
        "inv-harbor-001 total: Total due: USD 4,800.00\ncontract-harbor scope: printing of marketing brochures",
      ),
    },
  ];
}
