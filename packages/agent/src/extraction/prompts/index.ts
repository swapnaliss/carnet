import type { ExtractionDocType } from "@carnet/domain";
import type { ExtractionPrompt } from "./common";
import { contractPrompt } from "./contract";
import { invoicePrompt } from "./invoice";
import { purchaseOrderPrompt } from "./purchase-order";
import { statementPrompt } from "./statement";

export type { ExtractionPrompt } from "./common";

export const EXTRACTION_PROMPTS: Record<ExtractionDocType, ExtractionPrompt> = {
  invoice: invoicePrompt,
  contract: contractPrompt,
  purchase_order: purchaseOrderPrompt,
  statement: statementPrompt,
};
