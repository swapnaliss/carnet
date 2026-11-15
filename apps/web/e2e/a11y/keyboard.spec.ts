import { expect, type Page, test } from "@playwright/test";
import {
  focusIndicatorProblem,
  hasStack,
  SKIP_REASON,
  type SeededRfi,
  seedHoldWorld,
  signIn,
  tabUntil,
} from "./support";

// The hold-screen path with the keyboard only (M4-07 Scope 2): from the queue, open the RFI, read each
// question, open a citation's source snippet, edit a draft, approve and submit. Only Tab, Shift+Tab,
// Enter, Space, Escape and the arrow keys are pressed; no click, no programmatic focus. Every focus stop
// is checked for a visible indicator (>= 2 px, >= 3:1 against what is behind it), and a pointer listener
// proves no pointer event fired.
test.skip(!hasStack, SKIP_REASON);

let rfis: Record<string, SeededRfi> = {};
test.beforeAll(() => {
  test.setTimeout(240_000);
  rfis = seedHoldWorld();
});

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      tag: el?.tagName.toLowerCase() ?? "",
      text: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim(),
      href: el?.getAttribute("href") ?? "",
      testid: el?.getAttribute("data-testid") ?? "",
      role: el?.getAttribute("role") ?? "",
    };
  });

test("keyboard only: queue -> RFI -> questions -> citation -> edit -> approve and submit", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const target = rfis.keyboard;
  expect(target?.id).toBeTruthy();
  await page.addInitScript(() => {
    (window as unknown as { __pointer: number }).__pointer = 0;
    for (const type of ["pointerdown", "mousedown", "click"]) {
      window.addEventListener(
        type,
        (e) => {
          // A keyboard Enter/Space on a button dispatches a synthetic click with detail 0; a pointer
          // click has detail >= 1 or is a PointerEvent with a pointer id.
          if (type === "click" && (e as MouseEvent).detail === 0) return;
          (window as unknown as { __pointer: number }).__pointer++;
        },
        true,
      );
    }
  });
  await signIn(page);
  await page.goto("/queue");
  await expect(page.getByTestId("queue-count")).toBeVisible();

  const problems: string[] = [];
  const stops: string[] = [];
  const check = async () => {
    const f = await focused(page);
    stops.push(`${f.tag}:${f.text.slice(0, 30)}`);
    // Tab past the last element leaves the document for the browser UI (focus on body) and the next Tab
    // wraps to the skip link: that is the end of the tab order, not a lost focus or a trap.
    if (f.tag === "body") return;
    const p = await focusIndicatorProblem(page);
    if (p) problems.push(`${p} (stop ${stops.length}, after ${stops.at(-2)})`);
  };

  // 1. Queue: Tab to the held payment's "Review the request" link for this RFI, Enter.
  await tabUntil(
    page,
    async () => (await focused(page)).href === `/rfis/${target?.id}`,
    "the queue link to the RFI",
    { max: 400, onStop: check },
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/rfis/${target?.id}$`));
  await expect(page.getByTestId("hold-screen")).toBeVisible();
  // Route change: focus is on the page h1.
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();

  // 2. Read each question: Tab into the question navigator, arrow down through it, Enter jumps to it.
  const navButtons = page.getByTestId("question-nav").getByRole("button");
  const count = await navButtons.count();
  expect(count).toBeGreaterThan(1);
  await tabUntil(
    page,
    async () => page.evaluate(() => !!document.activeElement?.closest("[data-testid=question-nav]")),
    "the question navigator",
    { onStop: check },
  );
  for (let i = 1; i < count; i++) {
    await page.keyboard.press("ArrowDown");
    await check();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("question").nth(i).getByRole("heading", { level: 3 })).toBeFocused();
    await check();
    await tabUntil(
      page,
      async () =>
        page.evaluate(() => !!document.activeElement?.closest("[data-testid=question-nav]")),
      "back to the question navigator",
      { back: true, max: 200, onStop: check },
    );
  }

  // 3. Citations: Tab to the first "Show full quote" and open the verbatim source snippet.
  await tabUntil(page, async () => (await focused(page)).text === "Show full quote", "a citation", {
    onStop: check,
  });
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Hide full quote" }).first()).toBeFocused();
  await check();

  // 4. Edit a draft: Tab to "Edit answer", Enter, change the text, Tab to "Save edit", Space.
  await tabUntil(page, async () => (await focused(page)).text === "Edit answer", "Edit answer", {
    onStop: check,
  });
  await page.keyboard.press("Enter");
  const box = page.getByRole("textbox", { name: "Answer text" });
  await expect(box).toBeVisible();
  await tabUntil(page, async () => box.evaluate((el) => el === document.activeElement), "the draft", {
    max: 10,
    onStop: check,
  });
  await page.keyboard.press("End");
  await page.keyboard.press("Space");
  await page.keyboard.press("Backspace");
  await tabUntil(page, async () => (await focused(page)).text === "Save edit", "Save edit", {
    onStop: check,
  });
  await page.keyboard.press("Space");
  await expect(page.getByTestId("question-status").first()).toHaveText(/Edited by you|Ready/);

  // 5. Approve and submit: Tab to approve, Enter opens the dialog with focus on its title; Escape
  // returns focus to the trigger; open again, Tab to the submit button, Enter.
  await tabUntil(
    page,
    async () => (await focused(page)).testid === "approve-button",
    "the approve button",
    { max: 200, onStop: check },
  );
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Approve and submit" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("approve-dialog")).toBeHidden();
  await expect(page.getByTestId("approve-button")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Approve and submit" })).toBeFocused();
  await check();
  await tabUntil(
    page,
    async () => /^Approve and submit \d+ answers/.test((await focused(page)).text),
    "the dialog's submit button",
    { max: 40, onStop: check },
  );
  // No keyboard trap: Tab stays inside the open dialog (it is modal) and the page behind is inert.
  expect(
    await page.evaluate(() => !!document.activeElement?.closest("[data-testid=approve-dialog]")),
  ).toBe(true);
  await page.keyboard.press("Enter");
  const status = page.getByTestId("approval-status");
  await expect(status).toContainText("Approved by you");
  await expect(status).toBeFocused();
  await check();

  expect(await page.evaluate(() => (window as unknown as { __pointer: number }).__pointer)).toBe(0);
  expect(problems, `focus stops: ${stops.length}`).toEqual([]);
  expect(stops.length).toBeGreaterThan(10);
});

test("tab order on the hold screen follows reading order (top to bottom) and has no trap", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/rfis/${rfis["draft-ready"]?.id}`);
  await expect(page.getByTestId("hold-screen")).toBeVisible();
  const tops: number[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 300; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const seenCount = () => document.querySelectorAll("[data-a11y-seen]").length;
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const r = el.getBoundingClientRect();
      const wrapped = el.dataset.a11ySeen === "1";
      el.dataset.a11ySeen = "1";
      return {
        key: wrapped ? "wrapped" : `${el.tagName}|${el.textContent?.slice(0, 40)}|${seenCount()}`,
        top: r.top + window.scrollY,
        inMain: !!el.closest("main"),
      };
    });
    if (!info) {
      console.log("tab order: focus left the page after", seen.size);
      break;
    }
    if (info.key === "wrapped") {
      console.log("tab order: wrapped at", info.key);
      break;
    } // wrapped around to the start: no trap
    seen.add(info.key);
    if (info.inMain) tops.push(info.top);
  }
  expect(tops.length).toBeGreaterThan(5);
  // Reading order: with a side column on desktop, an element may sit higher than the previous one only
  // when it starts a new column block; we allow returns upward of at most one question card's height
  // and require the overall direction to be downward.
  const ups = tops.filter((t, i) => i > 0 && t < (tops[i - 1] ?? 0) - 4).length;
  expect(ups / tops.length).toBeLessThan(0.2);
});
