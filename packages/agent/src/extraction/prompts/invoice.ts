import { buildPrompt } from "./common";

export const invoicePrompt = buildPrompt("invoice", "The document is a supplier invoice.", {
  invoice_number: "the invoice number",
  invoice_date: "the date the invoice was issued",
  due_date: "the payment due date",
  supplier: "the party that issued the invoice (the 'From' party)",
  buyer: "the party billed (the 'Bill to' party)",
  total: "the total amount due",
  line_item_total: "the sum of the line items, when printed separately from the total",
  beneficiary: "the name of the bank account holder to be paid",
  account_number: "the beneficiary bank account number",
  iban: "the beneficiary IBAN",
  bank_reference: "a payment reference the payer must quote",
  purchase_order: "the purchase order number the invoice refers to",
});
