import { describe, expect, it } from "vitest";
import { DISCLOSURE_LEVELS, PAYEE_STATUSES, payeeStatus } from "./payee-status";
import { TRANSFER_STATUSES, type TransferStatus } from "./status";

// GENERIC, no hold: every one of the eleven statuses.
const GENERIC: Record<TransferStatus, string> = {
  IN_APPROVAL: "PROCESSING",
  APPROVAL_RECALLED: "FAILED",
  APPROVAL_REJECTED: "FAILED",
  APPROVAL_BLOCKED: "FAILED",
  SCHEDULED: "PROCESSING",
  OVERDUE: "PROCESSING",
  PROCESSING: "PROCESSING",
  SENT: "SENT",
  PAID: "PAID",
  FAILED: "FAILED",
  CANCELLED: "FAILED",
};

describe("payeeStatus is total over 11 transfer statuses x held x both levels", () => {
  it("covers every transfer status in the table above", () => {
    expect(Object.keys(GENERIC).sort()).toEqual([...TRANSFER_STATUSES].sort());
    expect(TRANSFER_STATUSES).toHaveLength(11);
  });

  for (const status of TRANSFER_STATUSES) {
    for (const openRfi of [false, true]) {
      for (const level of DISCLOSURE_LEVELS) {
        it(`${status} openRfi=${openRfi} ${level}`, () => {
          const got = payeeStatus(status, openRfi, level);
          expect(PAYEE_STATUSES).toContain(got);
          const heldAndMoving = openRfi && (status === "SCHEDULED" || status === "PROCESSING");
          if (heldAndMoving && level === "DELAYED_FOR_VERIFICATION") {
            expect(got).toBe("DELAYED_FOR_VERIFICATION");
          } else {
            // A GENERIC link, or a link that is not held, reads exactly like the unheld table.
            expect(got).toBe(GENERIC[status]);
          }
        });
      }
    }
  }

  it("a held payment on a GENERIC link is indistinguishable from an ordinary Processing one", () => {
    for (const status of TRANSFER_STATUSES) {
      expect(payeeStatus(status, true, "GENERIC")).toBe(payeeStatus(status, false, "GENERIC"));
    }
  });

  it("an RFI alone never produces Sent, Paid or Failed", () => {
    expect(payeeStatus("PROCESSING", true, "GENERIC")).toBe("PROCESSING");
    expect(payeeStatus("IN_APPROVAL", true, "DELAYED_FOR_VERIFICATION")).toBe("PROCESSING");
  });

  it("once the transfer is SENT both levels read Sent, even with an RFI still open", () => {
    for (const level of DISCLOSURE_LEVELS) {
      expect(payeeStatus("SENT", true, level)).toBe("SENT");
      expect(payeeStatus("SENT", false, level)).toBe("SENT");
    }
  });

  it("no transfer yet reads Processing", () => {
    expect(payeeStatus(null, false, "GENERIC")).toBe("PROCESSING");
    expect(payeeStatus(null, true, "DELAYED_FOR_VERIFICATION")).toBe("PROCESSING");
  });
});
