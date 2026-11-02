import { describe, expect, it } from "vitest";
import { describePackage } from "./index";

describe("@carnet/agent", () => {
  it("is wired into the workspace", () => {
    expect(describePackage()).toBe("@carnet/agent ready");
  });
});
