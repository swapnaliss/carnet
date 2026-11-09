// M2-07 AC 10: the executor holds no model code. The respond executor, the approval server code, the
// sweep and the approvals domain import nothing from the agent package (ADR 0009), directly or by relative
// path.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function files(path: string): string[] {
  const full = join(root, path);
  if (statSync(full).isFile()) return [full];
  return readdirSync(full).flatMap((f) => files(join(path, f)));
}

const EXECUTOR = [
  "apps/web/src/worker/handlers/rfi-respond.ts",
  "apps/web/src/worker/approval-sweep.ts",
  "apps/web/src/server/approvals.ts",
  "apps/web/src/server/approval-routes.ts",
  "packages/domain/src/approvals",
  "packages/db/src/repos/approvals.ts",
  "packages/db/src/repos/approval-sweeps.ts",
];

describe("the executor imports no model code", () => {
  for (const path of EXECUTOR.flatMap(files)) {
    it(path.slice(root.length), () => {
      const imports = [...readFileSync(path, "utf8").matchAll(/from\s+["']([^"']+)["']/g)].map(
        (m) => m[1] ?? "",
      );
      const offending = imports.filter((i) =>
        /@carnet\/agent|packages\/agent|@anthropic-ai/.test(i),
      );
      expect(offending).toEqual([]);
    });
  }
});
