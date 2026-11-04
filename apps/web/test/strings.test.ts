import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { strings, t } from "../src/strings";

const webRoot = join(import.meta.dirname, "..");

// Shell files the rule covers: every component, and every page, layout and boundary file in `app`.
function shellFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx$/.test(name)) out.push(p);
    }
  };
  walk(join(webRoot, "src/components"));
  walk(join(webRoot, "src/app"));
  return out;
}

// Attributes a person reads or hears. Others (className, href, id, role, type, ...) are not copy.
const USER_FACING_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-roledescription",
  "aria-valuetext",
  "alt",
  "title",
  "placeholder",
  "label",
]);

/** User-facing string literals written directly in JSX: text, `{"..."}` children and copy attributes. */
export function jsxLiterals(source: string, fileName: string): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && node.text.trim() !== "") {
      found.push(node.text.trim());
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isStringLiteral(node.expression) ||
        ts.isNoSubstitutionTemplateLiteral(node.expression)) &&
      !ts.isJsxAttribute(node.parent) &&
      node.expression.text.trim() !== ""
    ) {
      found.push(node.expression.text);
    } else if (ts.isJsxAttribute(node) && USER_FACING_ATTRIBUTES.has(node.name.getText(file))) {
      const init = node.initializer;
      const literal =
        init && ts.isStringLiteral(init)
          ? init
          : init &&
              ts.isJsxExpression(init) &&
              init.expression &&
              ts.isStringLiteral(init.expression)
            ? init.expression
            : undefined;
      if (literal && literal.text.trim() !== "") found.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("strings module", () => {
  it("exposes English as the active locale", () => {
    expect(t).toBe(strings.en);
    expect(t.app.name).toBe("Carnet");
  });

  it("has no empty strings", () => {
    const walk = (value: unknown, path: string) => {
      if (typeof value === "string") expect(value.trim(), path).not.toBe("");
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      }
    };
    walk(strings.en, "en");
  });
});

describe("no inline user-facing literals in shell JSX", () => {
  it("the detector catches text, string children and copy attributes, and ignores class names", () => {
    const sample = `export const A = () => (
      <div className="p-4" aria-label="Main">
        Hello
        {"there"}
        <img alt="logo" src="/x.png" />
        <span>{t.app.name}</span>
      </div>
    );`;
    expect(jsxLiterals(sample, "sample.tsx")).toEqual(["Main", "Hello", "there", "logo"]);
  });

  const files = shellFiles();

  it("finds the shell files", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${relative(webRoot, file)} has no JSX text literal`, () => {
      expect(jsxLiterals(readFileSync(file, "utf8"), file)).toEqual([]);
    });
  }
});
