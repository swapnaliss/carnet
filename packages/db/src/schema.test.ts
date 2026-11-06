import {
  AIRWALLEX_RFI_STATUSES,
  RFI_ORPHAN_REASONS,
  RFI_STATES,
  TRANSFER_STATUSES,
} from "@carnet/domain";
import { describe, expect, it } from "vitest";
import {
  DuplicateRequestIdError,
  pgErrorOf,
  translateDbError,
  UniqueViolationError,
} from "./errors";
import {
  AIRWALLEX_RFI_STATUS_VALUES,
  RFI_ORPHAN_REASON_VALUES,
  RFI_STATE_VALUES,
  TRANSFER_STATUS_VALUES,
} from "./schema/index";

describe("schema", () => {
  it("the payments.transfer_status CHECK list equals the domain's TRANSFER_STATUSES", () => {
    expect([...TRANSFER_STATUS_VALUES]).toEqual([...TRANSFER_STATUSES]);
  });
  it("the rfis CHECK lists equal the domain's RFI states, orphan reasons and Airwallex statuses", () => {
    expect([...RFI_STATE_VALUES]).toEqual([...RFI_STATES]);
    expect([...RFI_ORPHAN_REASON_VALUES]).toEqual([...RFI_ORPHAN_REASONS]);
    expect([...AIRWALLEX_RFI_STATUS_VALUES]).toEqual([...AIRWALLEX_RFI_STATUSES]);
  });
});

describe("db errors", () => {
  it("finds the pg error inside a Drizzle wrapper", () => {
    const wrapped = { message: "Failed query", cause: { code: "23505", constraint: "x_key" } };
    expect(pgErrorOf(wrapped)).toEqual({ code: "23505", constraint: "x_key" });
    expect(translateDbError(wrapped)).toBeInstanceOf(UniqueViolationError);
  });

  it("leaves non-database errors untouched", () => {
    const e = new Error("boom");
    expect(pgErrorOf(e)).toBeNull();
    expect(translateDbError(e)).toBe(e);
  });

  it("typed errors carry their key", () => {
    const e = new DuplicateRequestIdError("rid");
    expect(e).toBeInstanceOf(UniqueViolationError);
    expect(e.requestId).toBe("rid");
    expect(e.name).toBe("DuplicateRequestIdError");
  });
});
