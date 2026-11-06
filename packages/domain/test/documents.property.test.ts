// Property test (M2-01 AC 4): every generated name comes out as a safe name of at most 50 characters
// that ends in the detected extension.
import { describe, expect, it } from "vitest";
import { FILENAME_MAX_LENGTH, sanitizeFilename } from "../src/index";
import { prng, RUNS } from "./prng";

const SAFE = /^[A-Za-z0-9 ._()-]+$/;
const PIECES = [
  "../",
  "..\\",
  "/",
  "\\",
  "..",
  ".",
  " ",
  "\t",
  "\n",
  "\r",
  "\u0000",
  "\u001b",
  "\u007f",
  '"',
  "'",
  ";",
  "%22",
  "‮", // right-to-left override
  "‭",
  "⁦",
  "⁩",
  "​", // zero width space
  "‏",
  "﻿",
  " ",
  "é",
  "ß",
  "Ω",
  "漢字",
  "😀",
  "invoice",
  "a".repeat(300),
  ".pdf",
  ".exe",
  ".PDF.exe",
  "CON",
  "-",
  "_",
  "(1)",
  "<script>",
  "&",
  "*",
  "?",
  ":",
  "|",
];

function check(raw: string, ext: string): void {
  const out = sanitizeFilename(raw, ext);
  const why = JSON.stringify({ raw, out });
  expect(out.length, why).toBeLessThanOrEqual(FILENAME_MAX_LENGTH);
  expect(out, why).toMatch(SAFE);
  expect(out.endsWith(`.${ext}`), why).toBe(true);
  expect(out.startsWith("."), why).toBe(false);
  expect(out.startsWith("-"), why).toBe(false);
  expect(out, why).not.toMatch(/\.\./);
  expect(out.length, why).toBeGreaterThan(ext.length + 1);
  // Idempotent: a sanitised name sanitises to itself.
  expect(sanitizeFilename(out, ext), why).toBe(out);
}

describe("sanitizeFilename over generated names", () => {
  it("the named hostile cases", () => {
    for (const ext of ["pdf", "jpg", "png"]) {
      for (const raw of [
        "../../x",
        "x".repeat(300),
        "inv‮fdp.exe",
        "line1\nline2.pdf",
        "quote\"d'.pdf",
        "...",
        ".",
        "..",
        "   ",
      ]) {
        check(raw, ext);
      }
    }
  });

  it(`${RUNS} random compositions`, () => {
    const r = prng(0x0d0c);
    for (let i = 0; i < RUNS; i++) {
      const n = r.int(0, 12);
      let raw = "";
      for (let k = 0; k < n; k++) {
        raw +=
          r.int(0, 3) === 0 ? String.fromCodePoint(r.int(0, 0x2ffff)) : r.pick(PIECES).toString();
      }
      check(raw, r.pick(["pdf", "jpg", "png"]));
    }
  });
});
