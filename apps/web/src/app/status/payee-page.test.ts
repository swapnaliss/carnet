// The public payee page as HTML (M3-06): words, shape, and the absence of every financial field.
import { PAYEE_STATUSES } from "@carnet/domain";
import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatUpdated,
  renderError,
  renderLimited,
  renderStatusPage,
  renderUnavailable,
} from "../../server/payee-page";
import { PAYEE_PAGE_HEADERS } from "../../server/payee-status-handler";

const UPDATED = new Date("2026-11-06T14:03:00.000Z");

const WORDS = {
  PROCESSING: "Processing",
  SENT: "Sent",
  PAID: "Paid",
  FAILED: "Failed",
  DELAYED_FOR_VERIFICATION: "Delayed for verification",
} as const;

describe("renderStatusPage", () => {
  it("has a word for every payee status", () => {
    expect(Object.keys(WORDS).sort()).toEqual([...PAYEE_STATUSES].sort());
  });

  for (const status of PAYEE_STATUSES) {
    it(`${status} shows its word and the update time`, () => {
      const html = renderStatusPage(status, UPDATED);
      expect(html).toContain(`>${WORDS[status]}</span>`);
      expect(html).toContain('<time datetime="2026-11-06T14:03:00.000Z">');
      expect(html).toContain("6 Nov 2026, 14:03 UTC");
    });
  }

  it("is a script-free, request-free document with robots and referrer metadata", () => {
    const html = renderStatusPage("PROCESSING", UPDATED);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<form|<a |src=|href=|@import|url\(/i);
  });

  it("matches the recorded snapshot (no amount, currency, name, reference, bank detail, ids)", () => {
    expect(renderStatusPage("PROCESSING", UPDATED)).toMatchSnapshot();
    expect(renderStatusPage("DELAYED_FOR_VERIFICATION", UPDATED)).toMatchSnapshot();
  });

  it("the unavailable, limited and error bodies carry no status and no time", () => {
    for (const html of [renderUnavailable(), renderLimited(), renderError()]) {
      expect(html).not.toMatch(/Processing|Sent|Paid|Failed|<time/);
    }
  });
});

describe("helpers", () => {
  it("escapes HTML", () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
  });
  it("formats the time in UTC", () => {
    expect(formatUpdated(new Date("2026-01-02T03:04:00Z"))).toBe("2 Jan 2026, 03:04 UTC");
  });
  it("every page response carries the privacy headers", () => {
    expect(PAYEE_PAGE_HEADERS["Referrer-Policy"]).toBe("no-referrer");
    expect(PAYEE_PAGE_HEADERS["X-Robots-Tag"]).toBe("noindex, nofollow");
    expect(PAYEE_PAGE_HEADERS["Cache-Control"]).toBe("no-store");
    expect(PAYEE_PAGE_HEADERS["X-Content-Type-Options"]).toBe("nosniff");
  });
});
