import { describe, expect, it } from "vitest";
import { describePackage } from "./index";

describe("@carnet/db", () => {
  it("is wired into the workspace", () => {
    expect(describePackage()).toBe("@carnet/db ready");
  });
});
