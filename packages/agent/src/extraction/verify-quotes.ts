// Quote verification in code (M2-02, ADR 0010). The model's quotes are checked against the PDF text
// layer: a fact is `quote_verified` only when its quote occurs on the claimed page and its value is
// derivable from the quote. Nothing the model says about its own confidence is used.
import {
  type ExtractedFact,
  type ExtractionDocType,
  type FactIssue,
  parseFactValue,
  quoteOccursOnPage,
  valueKindOf,
  valueSupportedByQuote,
} from "@carnet/domain";
import { extractText, getDocumentProxy } from "unpdf";

/** Fewer visible characters than this across all pages means the PDF has no usable text layer. */
export const MIN_TEXT_LAYER_CHARS = 30;

export interface TextLayer {
  /** Text per page, in page order (index 0 is page 1). */
  readonly pages: readonly string[];
}

/** The text layer of a PDF, or null when it is image-only (or unreadable). */
export async function readTextLayer(bytes: Uint8Array): Promise<TextLayer | null> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = text.map((t) => t);
    const visible = pages.join("").replace(/\s+/g, "").length;
    return visible >= MIN_TEXT_LAYER_CHARS ? { pages } : null;
  } catch {
    return null;
  }
}

export interface RawFact {
  readonly key: string;
  readonly value: string;
  readonly quote: string;
  readonly page: number;
}

/**
 * Turns the model's facts into stored facts. With a text layer, `quote_verified` is decided here. With
 * none (an image or a scanned PDF) every fact is `needs_confirmation` and none is verified.
 */
export function verifyFacts(
  type: ExtractionDocType,
  raw: readonly RawFact[],
  layer: TextLayer | null,
): ExtractedFact[] {
  return raw.map((fact) => {
    const kind = valueKindOf(type, fact.key);
    const parsed = kind ? parseFactValue(kind, fact.value) : null;
    const issues: FactIssue[] = [];
    if (parsed === null) issues.push("unparseable_value");
    if (layer === null) {
      issues.push("no_text_layer");
      return {
        key: fact.key,
        value: fact.value,
        parsed,
        quote: fact.quote,
        page: Math.max(0, fact.page),
        quote_verified: false,
        needs_confirmation: true,
        issues,
      };
    }
    const pageText = fact.page >= 1 ? layer.pages[fact.page - 1] : undefined;
    if (pageText === undefined) issues.push("page_out_of_range");
    else if (!quoteOccursOnPage(fact.quote, pageText)) issues.push("quote_not_found");
    else if (parsed !== null && !valueSupportedByQuote(parsed, fact.quote)) {
      issues.push("value_not_in_quote");
    }
    return {
      key: fact.key,
      value: fact.value,
      parsed,
      quote: fact.quote,
      page: Math.max(0, fact.page),
      quote_verified: issues.length === 0,
      needs_confirmation: false,
      issues,
    };
  });
}
