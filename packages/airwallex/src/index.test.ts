import { describe, expect, it } from "vitest";
import { describePackage } from "./index";

describe("@carnet/airwallex", () => {
  it("is wired into the workspace", () => {
    expect(describePackage()).toBe("@carnet/airwallex ready");
  });
});
