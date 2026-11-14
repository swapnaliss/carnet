import { expect, type Page, test } from "@playwright/test";

// CSP and security headers on the production build (M1-10). The shell home and /login load with zero
// CSP violations: none reported by the browser's `securitypolicyviolation` event, none in the console.
// Then /login, /healthz and an API route are fetched and every security header is checked.

const EXPECTED = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  // `next start` runs with NODE_ENV=production.
  "strict-transport-security": "max-age=63072000; includeSubDomains",
} as const;

async function collectViolations(page: Page): Promise<string[]> {
  const found: string[] = [];
  page.on("console", (msg) => {
    if (/content security policy|refused to (execute|load|apply)/i.test(msg.text())) {
      found.push(`console: ${msg.text()}`);
    }
  });
  await page.exposeFunction("__cspViolation", (v: string) => found.push(`event: ${v}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (e) => {
      const report = (window as unknown as { __cspViolation: (v: string) => void }).__cspViolation;
      report(
        `${e.violatedDirective} blocked=${e.blockedURI} source=${e.sourceFile}:${e.lineNumber} sample=${e.sample} document=${e.documentURI}`,
      );
    });
  });
  return found;
}

for (const path of ["/", "/login"]) {
  test(`${path} loads with zero CSP violations and hydrates`, async ({ page }) => {
    const violations = await collectViolations(page);
    const res = await page.goto(path);
    const csp = res?.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    await expect(page.locator("main")).toBeVisible();
    // Every script in the server's HTML carries the response's nonce. Checked on the response, not the
    // live DOM: the runtime adds chunk <script src> elements without a nonce once hydration starts
    // (allowed by 'strict-dynamic'), so a DOM read races with them (BL-01, 2026-11-13).
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    const tags = (await res?.text())?.match(/<script\b[^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(0);
    for (const tag of tags) expect(tag, tag).toContain(`nonce="${nonce}"`);
    // Every client bundle has loaded (and would have reported a blocked script by now).
    await page.waitForLoadState("networkidle");
    // The message prints every violation, so a CI failure names its cause (BL-01, 2026-11-13).
    expect(violations, `CSP violations on ${path}:\n${violations.join("\n")}`).toEqual([]);
  });
}

test("the detector catches a real violation (an injected inline handler is blocked)", async ({
  page,
}) => {
  const violations = await collectViolations(page);
  await page.goto("/");
  await page.evaluate(() => {
    const div = document.createElement("div");
    div.innerHTML = '<img src="data:," alt="" onload="window.__pwned = true">';
    document.body.append(div);
  });
  await expect.poll(() => violations.length).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned),
  ).toBeUndefined();
});

for (const [path, method] of [
  ["/login", "GET"],
  ["/healthz", "GET"],
  ["/api/webhooks/airwallex", "POST"],
] as const) {
  test(`${method} ${path} carries every security header`, async ({ request }) => {
    const res =
      method === "GET"
        ? await request.get(path)
        : await request.post(path, { data: "{}", headers: { "content-type": "application/json" } });
    const headers = res.headers();
    for (const [name, value] of Object.entries(EXPECTED)) expect(headers[name], name).toBe(value);
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(/script-src[^;]*'unsafe-inline'/.test(csp)).toBe(false);
  });
}
