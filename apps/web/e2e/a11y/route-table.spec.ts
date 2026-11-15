import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { appRoutes, CONVENTIONS, COVERAGE } from "./routes";

// Fails when the App Router tree gains a route that the axe suite does not open (M4-07 AC 1), when a
// listed route no longer exists, or when a listed state has no case in axe.spec.ts. Needs no server.
const axeSource = readFileSync(new URL("./axe.spec.ts", import.meta.url), "utf8");
const cases = [...axeSource.matchAll(/route: "([^"]+)",\s*state: "([^"]+)"/g)].map((m) => ({
  route: m[1] as string,
  state: m[2] as string,
}));

test("every route in apps/web/src/app is listed in the a11y coverage table", () => {
  expect(appRoutes()).toEqual(Object.keys(COVERAGE).sort());
});

test("every listed route and state has an axe case, and every axe case is listed", () => {
  const listed = [...Object.entries(COVERAGE), ...Object.entries(CONVENTIONS)].flatMap(
    ([route, states]) => states.map((state) => `${route} · ${state}`),
  );
  expect(cases.map((c) => `${c.route} · ${c.state}`).sort()).toEqual(listed.sort());
});
