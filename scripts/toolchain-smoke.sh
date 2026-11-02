#!/usr/bin/env bash
# Toolchain smoke (M0-02, rerun by M0-GATE): next build, drizzle-kit generate against a throwaway
# one-table schema, vitest run. Exits non-zero on the first failure.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== next build"
npm run build

echo "== drizzle-kit generate (throwaway schema)"
smoke=packages/db/.smoke
rm -rf "$smoke"; mkdir -p "$smoke"
trap 'rm -rf "$smoke"' EXIT
cat > "$smoke/schema.ts" <<'TS'
import { integer, pgTable, text } from "drizzle-orm/pg-core";
export const smoke = pgTable("smoke", { id: integer("id").primaryKey(), note: text("note") });
TS
cat > "$smoke/drizzle.config.ts" <<'TS'
import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "postgresql", schema: "./.smoke/schema.ts", out: "./.smoke/out" });
TS
(cd packages/db && npx drizzle-kit generate --config .smoke/drizzle.config.ts)
ls "$smoke"/out/*.sql >/dev/null

echo "== vitest run"
npm test
echo "toolchain-smoke: ok"
