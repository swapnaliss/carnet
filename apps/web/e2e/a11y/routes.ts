import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The app's route table, read from the App Router tree (apps/web/src/app): every `page.tsx` is a route,
// route groups `(name)` drop out, and a `route.ts` outside `api/` that serves HTML counts too. The axe
// suite (axe.spec.ts) must name every route here with at least one state; route-table.spec.ts fails
// when a new route has no axe case (M4-07 AC 1).
const APP = fileURLToPath(new URL("../../src/app/", import.meta.url));

/** Route handlers that are not pages a person sees, each with the reason it has no axe case. */
export const NON_PAGE_HANDLERS: Readonly<Record<string, string>> = {
  "/healthz": "JSON health probe for the platform, no HTML",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

export function appRoutes(): string[] {
  const routes = new Set<string>();
  for (const file of walk(APP)) {
    const rel = relative(APP, file).split(sep);
    const leaf = rel.at(-1);
    if (rel[0] === "api") continue;
    if (leaf !== "page.tsx" && leaf !== "route.ts") continue;
    const segs = rel.slice(0, -1).filter((s) => !(s.startsWith("(") && s.endsWith(")")));
    const route = `/${segs.join("/")}`;
    if (leaf === "route.ts" && route in NON_PAGE_HANDLERS) continue;
    routes.add(route);
  }
  return [...routes].sort();
}

/**
 * Every route and the states the axe suite opens on it. Special file conventions (not-found, forbidden,
 * error) have no route of their own and are listed under the pseudo-routes in `CONVENTIONS`.
 */
export const COVERAGE: Readonly<Record<string, readonly string[]>> = {
  "/": ["home"],
  "/login": ["login"],
  "/queue": ["queue with payments"],
  "/queue/preview-loading": ["queue loading"],
  "/queue/preview-error": ["queue error"],
  "/payments": ["new payment form"],
  "/payments/[id]": ["payment detail with payee links"],
  "/payments/[id]/evidence": ["evidence view"],
  "/payments/[id]/evidence/preview-loading": ["evidence loading"],
  "/payments/[id]/evidence/preview-error": ["evidence error"],
  "/rfis": ["rfi list", "rfi list empty", "rfi list error"],
  "/rfis/[id]": [
    "hold drafted",
    "hold needs owner",
    "hold edited",
    "hold approve dialog",
    "hold approved",
    "hold answered",
    "hold expired",
    "hold model unavailable",
    "hold orphan",
    "hold kill switch",
  ],
  "/rfis-loading-preview": ["hold loading"],
  "/plan": ["plan empty (no session)"],
  "/plans/current": ["plan current"],
  "/plans/[revision]": ["plan revision"],
  "/plans/loading-preview": ["plan loading"],
  "/plans/error-preview": ["plan error"],
  "/plans/states-preview": ["plan states"],
  "/ops": ["ops with kill switch panel"],
  "/error-preview": ["page error"],
  "/status/[token]": ["payee status", "payee link not available"],
};

export const CONVENTIONS: Readonly<Record<string, readonly string[]>> = {
  "not-found": ["not found"],
  forbidden: ["forbidden (viewer on /ops)"],
};
