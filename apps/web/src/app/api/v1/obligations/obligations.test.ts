// M3-01 checks that need no database: request shapes, and that no worker or agent code path can write
// an obligation's criticality (AC: the confirm path is imported by the confirm route only).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "@carnet/db";
import { ConfirmCriticalityBodySchema, CreateObligationBodySchema } from "@carnet/domain";
import { describe, expect, it } from "vitest";

const WEB = fileURLToPath(new URL("../../../../../", import.meta.url));
const REPO = join(WEB, "../../");

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });

describe("request shapes", () => {
  it("create takes integer minor units as a string and rejects unknown keys", () => {
    const ok = {
      counterparty_id: crypto.randomUUID(),
      amount_minor: "840000",
      currency: "EUR",
      due_at: "2026-12-01T00:00:00Z",
    };
    expect(CreateObligationBodySchema.safeParse(ok).success).toBe(true);
    expect(CreateObligationBodySchema.safeParse({ ...ok, amount_minor: "84.00" }).success).toBe(
      false,
    );
    expect(CreateObligationBodySchema.safeParse({ ...ok, criticality: 1 }).success).toBe(false);
  });
  it("confirm takes 1, 2 or 3 and nothing else", () => {
    expect(ConfirmCriticalityBodySchema.safeParse({ criticality: 3 }).success).toBe(true);
    expect(ConfirmCriticalityBodySchema.safeParse({ criticality: 4 }).success).toBe(false);
    expect(ConfirmCriticalityBodySchema.safeParse({ criticality: 1, by: "x" }).success).toBe(false);
  });
});

describe("no self-confirmation path", () => {
  it("confirmCriticality is the only exported writer of criticality, and only the confirm route imports it", () => {
    const users = [
      ...sources(join(WEB, "src")),
      ...sources(join(REPO, "packages/agent/src")),
      ...sources(join(REPO, "packages/db/src")),
    ]
      .filter((f) => !f.endsWith("obligation-confirm.ts"))
      .filter((f) =>
        /^(import|export)\b[^;]*(confirmCriticality|obligation-confirm)[^;]*;/m.test(
          readFileSync(f, "utf8"),
        ),
      );
    const rel = users.map((f) => f.slice(REPO.length));
    expect(rel.sort()).toEqual(
      ["apps/web/src/server/obligation-routes.ts", "packages/db/src/repos/index.ts"].sort(),
    );
    const exported = Object.keys(db).filter((k) => /criticality/i.test(k));
    expect(exported.filter((k) => /confirm/i.test(k))).toEqual(["confirmCriticality"]);
  });

  it("no other repository or worker file writes the criticality column", () => {
    const writers = [
      ...sources(join(WEB, "src/worker")),
      ...sources(join(REPO, "packages/db/src/repos")),
    ]
      .filter((f) => !f.endsWith("obligation-confirm.ts"))
      .filter(
        (f) =>
          /criticality(ConfirmedBy)?\s*:/.test(readFileSync(f, "utf8")) &&
          /\.(update|set)\(/.test(readFileSync(f, "utf8")),
      )
      .map((f) => f.slice(REPO.length));
    expect(writers).toEqual([]);
  });
});
