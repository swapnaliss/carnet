// The API route inventory shared by routes.test.ts and cross-tenant.int.test.ts.
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const API_DIR = fileURLToPath(new URL("../../src/app/api/", import.meta.url));

/** Every route.ts under src/app/api, as its directory relative to api/ (e.g. "webhooks/airwallex"). */
export function apiRoutes(dir = API_DIR): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...apiRoutes(full));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(name)) out.push(relative(API_DIR, dir));
  }
  return out.sort();
}
