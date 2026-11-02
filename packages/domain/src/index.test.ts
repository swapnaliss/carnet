import { describe, expect, it } from "vitest";
import { describePackage } from "./index";

describe("@carnet/domain", () => {
  it("is wired into the workspace", () => {
    expect(describePackage()).toBe("@carnet/domain ready");
  });
});
