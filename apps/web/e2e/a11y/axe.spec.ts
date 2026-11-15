import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  AXE_DIR,
  expectNoAxeViolations,
  hasStack,
  type SeededRfi,
  SKIP_REASON,
  seedHold,
  seedHoldWorld,
  seedPlan,
  signIn,
} from "./support";

// Axe on every route and state of the app (M4-07 Scope 1), light and dark, against the production build
// and a database seeded with real pipeline output over recorded responses. The bar is ZERO WCAG 2.0/2.1/
// 2.2 A and AA violations of any impact; exclusions live in support.ts (EXCLUDED_RULES, currently none).
// The route list is checked against the App Router tree by route-table.spec.ts.
test.skip(!hasStack, SKIP_REASON);

interface Ctx {
  rfis: Record<string, SeededRfi>;
}
interface Case {
  route: string;
  state: string;
  role?: "owner" | "judge" | null;
  run: (page: Page, ctx: Ctx) => Promise<void>;
}

const ready = (page: Page) => expect(page.locator("main")).toBeVisible();
const hold = async (page: Page, ctx: Ctx, name: string) => {
  await page.goto(`/rfis/${ctx.rfis[name]?.id}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
};

const CASES: Case[] = [
  {
    route: "/",
    state: "home",
    role: null,
    run: async (p) => {
      await p.goto("/");
      await ready(p);
    },
  },
  {
    route: "/login",
    state: "login",
    role: null,
    run: async (p) => {
      await p.goto("/login");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/queue",
    state: "queue with payments",
    run: async (p) => {
      await p.goto("/queue");
      await expect(p.getByTestId("queue-count")).toBeVisible();
    },
  },
  {
    route: "/queue/preview-loading",
    state: "queue loading",
    run: async (p) => {
      await p.goto("/queue/preview-loading", { waitUntil: "commit" });
      await expect(
        p
          .locator("main [aria-busy='true'], main [data-testid$='skeleton'], main [role='status']")
          .first(),
      ).toBeAttached();
    },
  },
  {
    route: "/queue/preview-error",
    state: "queue error",
    run: async (p) => {
      await p.goto("/queue/preview-error");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/payments",
    state: "new payment form",
    run: async (p) => {
      await p.goto("/payments");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/payments/[id]",
    state: "payment detail with payee links",
    run: async (p, c) => {
      await p.goto(`/payments/${c.rfis["draft-ready"]?.paymentId}`);
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/payments/[id]/evidence",
    state: "evidence view",
    run: async (p, c) => {
      await p.goto(`/payments/${c.rfis["draft-ready"]?.paymentId}/evidence`);
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/payments/[id]/evidence/preview-loading",
    state: "evidence loading",
    run: async (p, c) => {
      await p.goto(`/payments/${c.rfis["draft-ready"]?.paymentId}/evidence/preview-loading`, {
        waitUntil: "commit",
      });
      await expect(
        p
          .locator("main [aria-busy='true'], main [data-testid$='skeleton'], main [role='status']")
          .first(),
      ).toBeAttached();
    },
  },
  {
    route: "/payments/[id]/evidence/preview-error",
    state: "evidence error",
    run: async (p, c) => {
      await p.goto(`/payments/${c.rfis["draft-ready"]?.paymentId}/evidence/preview-error`);
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/rfis",
    state: "rfi list",
    run: async (p) => {
      await p.goto("/rfis");
      await expect(p.getByTestId("rfi-row").first()).toBeVisible();
    },
  },
  {
    route: "/rfis",
    state: "rfi list empty",
    run: async (p) => {
      await p.route("**/api/v1/rfis?*", (r) => r.fulfill({ json: { items: [] } }));
      await p.goto("/rfis");
      await expect(p.getByRole("heading", { name: "No requests from Airwallex" })).toBeVisible();
    },
  },
  {
    route: "/rfis",
    state: "rfi list error",
    run: async (p) => {
      await p.route("**/api/v1/rfis?*", (r) => r.fulfill({ status: 500, body: "{}" }));
      await p.goto("/rfis");
      await expect(p.getByTestId("rfi-list-error")).toBeVisible();
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold drafted",
    run: async (p, c) => {
      await hold(p, c, "draft-ready");
      await expect(p.getByTestId("question-status").first()).toHaveText("Ready");
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold needs owner",
    run: async (p, c) => {
      await hold(p, c, "needs-owner-view");
      await expect(p.getByTestId("needs-owner").first()).toBeVisible();
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold edited",
    run: async (p, c) => {
      await hold(p, c, "edit");
      const first = p.getByTestId("question").first();
      await first.getByRole("button", { name: "Edit answer" }).click();
      const box = first.getByRole("textbox", { name: "Answer text" });
      await box.fill(await box.inputValue());
      await first.getByRole("button", { name: "Save edit" }).click();
      await expect(first.getByTestId("question-status")).toHaveText("Edited by you");
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold approve dialog",
    run: async (p, c) => {
      await hold(p, c, "draft-ready");
      await p.getByTestId("approve-button").click();
      await expect(p.getByTestId("approve-dialog")).toBeVisible();
      await p.getByRole("button", { name: "Show what this approval binds" }).click();
      await expect(p.getByTestId("dialog-bound")).toBeVisible();
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold approved",
    run: async (p, c) => {
      await hold(p, c, "approve");
      // The light run approves; the dark run opens the same, already approved RFI.
      if (await p.getByTestId("approval-status").getByText("Approved by you").count()) return;
      await p.getByTestId("approve-button").click();
      await p
        .getByTestId("approve-dialog")
        .getByRole("button", { name: /Approve and submit \d+ answers/ })
        .click();
      await expect(p.getByTestId("approval-status")).toContainText("Approved by you");
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold answered",
    run: async (p, c) => {
      await hold(p, c, "answered");
      await expect(p.getByTestId("hold-answered")).toBeVisible();
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold expired",
    run: async (p, c) => {
      await hold(p, c, "expired");
      await expect(p.getByTestId("hold-expired")).toBeVisible();
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold model unavailable",
    run: async (p, c) => {
      await hold(p, c, "model-unavailable");
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold orphan",
    run: async (p, c) => {
      await hold(p, c, "orphan");
      await expect(p.getByRole("combobox", { name: "Link to payment" })).toBeVisible();
    },
  },
  {
    route: "/rfis/[id]",
    state: "hold kill switch",
    run: async (p, c) => {
      seedHold("kill", "on");
      try {
        await hold(p, c, "draft-ready");
        await expect(p.getByTestId("hold-killswitch")).toBeVisible();
      } catch (e) {
        seedHold("kill", "off");
        throw e;
      }
    },
  },
  {
    route: "/rfis-loading-preview",
    state: "hold loading",
    run: async (p) => {
      await p.goto("/rfis-loading-preview");
      await expect(p.getByTestId("hold-skeleton")).toBeVisible();
    },
  },
  {
    route: "/plan",
    state: "plan empty (no session)",
    role: null,
    run: async (p) => {
      await p.goto("/plan");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/plans/current",
    state: "plan current",
    run: async (p) => {
      await p.goto("/plans/current");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(p.getByText("Revision", { exact: false }).first()).toBeVisible();
    },
  },
  {
    route: "/plans/[revision]",
    state: "plan revision",
    run: async (p) => {
      await p.goto("/plans/1");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/plans/loading-preview",
    state: "plan loading",
    run: async (p) => {
      await p.goto("/plans/loading-preview", { waitUntil: "commit" });
      await expect(
        p
          .locator("main [aria-busy='true'], main [data-testid$='skeleton'], main [role='status']")
          .first(),
      ).toBeAttached();
    },
  },
  {
    route: "/plans/error-preview",
    state: "plan error",
    run: async (p) => {
      await p.goto("/plans/error-preview");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/plans/states-preview",
    state: "plan states",
    run: async (p) => {
      await p.goto("/plans/states-preview");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/ops",
    state: "ops with kill switch panel",
    run: async (p) => {
      await p.goto("/ops");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/error-preview",
    state: "page error",
    role: null,
    run: async (p) => {
      await p.goto("/error-preview");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "/status/[token]",
    state: "payee status",
    run: async (p, c) => {
      await p.goto(`/payments/${c.rfis.answered?.paymentId}`);
      await p.getByRole("button", { name: "Create status link" }).click();
      const url = await p.getByLabel("Link address").inputValue();
      await p.context().clearCookies();
      await p.goto(url);
      await expect(p.getByRole("heading", { level: 1, name: "Payment status" })).toBeVisible();
    },
  },
  {
    route: "/status/[token]",
    state: "payee link not available",
    role: null,
    run: async (p) => {
      await p.goto(`/status/${"A".repeat(43)}`);
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "not-found",
    state: "not found",
    role: null,
    run: async (p) => {
      await p.goto("/does-not-exist");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
  {
    route: "forbidden",
    state: "forbidden (viewer on /ops)",
    role: "judge",
    run: async (p) => {
      await p.goto("/ops");
      await expect(p.getByRole("heading", { level: 1 })).toBeVisible();
    },
  },
];

let ctx: Ctx = { rfis: {} };
// One seed per run: a failed test restarts the worker and re-runs beforeAll, which reuses this file.
const SEED_FILE = join(AXE_DIR, `seed-${process.env.A11Y_RUN_ID ?? process.ppid}.json`);
test.beforeAll(() => {
  test.setTimeout(240_000);
  if (existsSync(SEED_FILE)) {
    ctx = JSON.parse(readFileSync(SEED_FILE, "utf8")) as Ctx;
    return;
  }
  seedPlan();
  ctx = { rfis: seedHoldWorld() };
  writeFileSync(SEED_FILE, JSON.stringify(ctx));
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`axe ${scheme}`, () => {
    test.use({ colorScheme: scheme });
    for (const c of CASES) {
      test(`${c.route} · ${c.state}`, async ({ page }, info: TestInfo) => {
        const role = c.role === undefined ? "owner" : c.role;
        if (role) await signIn(page, role);
        try {
          await c.run(page, ctx);
          await expectNoAxeViolations(page, `${scheme}-${c.route}-${c.state}`, info);
        } finally {
          if (c.state === "hold kill switch") seedHold("kill", "off");
        }
      });
    }
  });
}
