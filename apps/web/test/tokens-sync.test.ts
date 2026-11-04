import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// docs/design/tokens.css is the source of truth; the app ships a copy because the Docker build
// context excludes docs/. They must stay identical.
const repo = join(import.meta.dirname, "../../..");

describe("design tokens", () => {
  it("apps/web/src/app/tokens.css is identical to docs/design/tokens.css", () => {
    const source = readFileSync(join(repo, "docs/design/tokens.css"), "utf8");
    const copy = readFileSync(join(repo, "apps/web/src/app/tokens.css"), "utf8");
    expect(copy).toBe(source);
  });
});
