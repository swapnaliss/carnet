import { buildPrompt } from "./common";

export const statementPrompt = buildPrompt(
  "statement",
  "The document is a bank or account statement. For a credit line, the quote is the whole line, including its date, amount and sender.",
  {
    account_holder: "the name of the account holder",
    period_start: "the first day of the statement period",
    period_end: "the last day of the statement period",
    opening_balance: "the balance at the start of the period",
    closing_balance: "the balance at the end of the period",
    credit: "the amount of one incoming payment (one fact per credit line)",
    payer: "the sender named on a credit line (one fact per credit line)",
  },
);
