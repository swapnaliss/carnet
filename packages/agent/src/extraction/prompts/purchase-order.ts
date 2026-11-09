import { buildPrompt } from "./common";

export const purchaseOrderPrompt = buildPrompt(
  "purchase_order",
  "The document is a purchase order issued by a buyer to a supplier.",
  {
    purchase_order: "the purchase order number",
    order_date: "the date of the order",
    buyer: "the party placing the order",
    supplier: "the party supplying the goods or services",
    total: "the order total",
    account_number: "the supplier bank account number",
    iban: "the supplier IBAN",
  },
);
