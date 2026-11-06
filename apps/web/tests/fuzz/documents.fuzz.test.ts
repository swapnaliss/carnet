// M2-01 fuzz (AC 10): generated upload bodies never produce a 5xx and never store a row for a
// rejected input. FUZZ_CASES sets the count (the validation gate uses 500); the generator is seeded,
// so a failure reproduces from the printed case number.

import { schema } from "@carnet/db";
import { count } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { beforeAll, describe, expect, it } from "vitest";
import { ORIGIN, sessionCookie, setupAuthTestEnv } from "../../test/auth/setup";
import { DEFAULT_TEST_LIMITS, dataset, documentRoutes } from "../../test/documents/support";

const CASES = Math.max(1, Number(process.env.FUZZ_CASES ?? "500") || 500);
const env = setupAuthTestEnv();

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]): T => items[int(0, items.length - 1)] as T;
  const bytes = (n: number) => {
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = int(0, 255);
    return out;
  };
  return { next, int, pick, bytes };
}
type Rng = ReturnType<typeof prng>;

const enc = (s: string) => new TextEncoder().encode(s);
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

const corpus: Record<string, Uint8Array> = {};
function pdfPages(pages: number): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const doc = new PDFDocument({ autoFirstPage: false });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    for (let i = 0; i < pages; i++) doc.addPage().text(`p${i}`);
    doc.end();
  });
}

function mutate(rng: Rng, src: Uint8Array): Uint8Array {
  const out = src.slice();
  const n = rng.int(1, 8);
  for (let i = 0; i < n; i++)
    out[rng.int(0, Math.min(out.length - 1, rng.next() < 0.5 ? 16 : out.length - 1))] = rng.int(
      0,
      255,
    );
  return out;
}

function multipart(boundary: string, parts: { headers: string; body: Uint8Array }[], close = true) {
  const chunks: Uint8Array[] = [];
  for (const p of parts)
    chunks.push(enc(`--${boundary}\r\n${p.headers}\r\n\r\n`), p.body, enc("\r\n"));
  if (close) chunks.push(enc(`--${boundary}--\r\n`));
  return concat(...chunks);
}

const filePart = (body: Uint8Array, name = "f.pdf", field = "file") => ({
  headers: `Content-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream`,
  body,
});

interface Generated {
  headers: Record<string, string>;
  body: Uint8Array | string;
  label: string;
}

function generate(rng: Rng): Generated {
  const boundary = `----fz${rng.int(0, 1e9)}`;
  const ct = { "content-type": `multipart/form-data; boundary=${boundary}` };
  const valid = rng.pick(Object.values(corpus));
  switch (rng.int(0, 11)) {
    case 0:
      return {
        label: "random bytes as file",
        headers: ct,
        body: multipart(boundary, [filePart(rng.bytes(rng.int(0, 4000)))]),
      };
    case 1:
      return {
        label: "pdf header + random",
        headers: ct,
        body: multipart(boundary, [
          filePart(concat(enc("%PDF-1.7\n"), rng.bytes(rng.int(0, 3000)))),
        ]),
      };
    case 2:
      return {
        label: "truncated valid",
        headers: ct,
        body: multipart(boundary, [filePart(valid.slice(0, rng.int(0, valid.length)))]),
      };
    case 3:
      return {
        label: "mutated header",
        headers: ct,
        body: multipart(boundary, [filePart(mutate(rng, valid))]),
      };
    case 4:
      return {
        label: "duplicate file fields",
        headers: ct,
        body: multipart(boundary, [filePart(valid), filePart(valid, "b.pdf")]),
      };
    case 5:
      return {
        label: "huge boundary",
        headers: {
          "content-type": `multipart/form-data; boundary=${"x".repeat(rng.int(70, 60000))}`,
        },
        body: rng.bytes(rng.int(0, 2000)),
      };
    case 6:
      return {
        label: "no closing boundary",
        headers: ct,
        body: multipart(boundary, [filePart(valid)], false),
      };
    case 7:
      return {
        label: "random body, multipart type",
        headers: ct,
        body: rng.bytes(rng.int(0, 6000)),
      };
    case 8:
      return {
        label: "wrong content type",
        headers: {
          "content-type": rng.pick([
            "application/json",
            "text/plain",
            "application/octet-stream",
            "multipart/mixed",
            "",
          ]),
        },
        body: rng.bytes(rng.int(0, 500)),
      };
    case 9:
      return {
        label: "hostile field names",
        headers: ct,
        body: multipart(boundary, [
          filePart(
            valid,
            "../../x‮.pdf",
            rng.pick(["kind", "file[]", "url", "FILE", "", "a".repeat(5000)]),
          ),
          {
            headers: 'Content-Disposition: form-data; name="kind"',
            body: rng.bytes(rng.int(0, 50)),
          },
        ]),
      };
    case 10:
      return {
        label: "malformed part headers",
        headers: ct,
        body: multipart(boundary, [
          {
            headers: rng.pick([
              "Content-Disposition: form-data",
              "x",
              'Content-Disposition: form-data; name="file"; filename="\u0000"',
              "\u0000\u0001",
            ]),
            body: valid,
          },
        ]),
      };
    default:
      return {
        label: "valid",
        headers: ct,
        body: multipart(boundary, [filePart(valid, "ok.pdf")]),
      };
  }
}

async function rows(): Promise<number> {
  return (await env().db.select({ n: count() }).from(schema.documents))[0]?.n ?? 0;
}

describe(`documents upload fuzz (${CASES} cases)`, () => {
  let cookie = "";
  beforeAll(async () => {
    corpus.pdf = dataset("inv-harbor-001.pdf");
    corpus.png = dataset("scans/inv-nordlicht-scan-001.png");
    corpus.jpg = dataset("scans/inv-nordlicht-scan-001.jpg");
    corpus.pdf21 = await pdfPages(21);
    cookie = await sessionCookie(env(), "owner@carnet.example", env().passwords.owner);
  });

  it("never 5xx, and stores a row only for a 200/201", async () => {
    const routes = documentRoutes(env(), {
      limits: { ...DEFAULT_TEST_LIMITS, sessionMaxFiles: 1_000_000, sessionMaxBytes: 2 ** 31 - 1 },
    });
    const rng = prng(0xf022);
    const statuses = new Map<number, number>();
    for (let i = 0; i < CASES; i++) {
      const g = generate(rng);
      const before = await rows();
      const res = await routes.upload(
        new Request(`${ORIGIN}/api/v1/documents`, {
          method: "POST",
          headers: { cookie, origin: ORIGIN, ...g.headers },
          body: typeof g.body === "string" ? g.body : (g.body as Uint8Array<ArrayBuffer>),
        }),
      );
      await res.arrayBuffer();
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      const ctx = `case ${i} (${g.label}) -> ${res.status}`;
      expect(res.status, ctx).toBeLessThan(500);
      const after = await rows();
      if (res.status === 201) expect(after, ctx).toBe(before + 1);
      else expect(after, ctx).toBe(before);
    }
    // The generator exercised both outcomes.
    expect([...statuses.keys()].some((s) => s >= 400)).toBe(true);
    expect(statuses.has(201) || statuses.has(200)).toBe(true);
  });
});
