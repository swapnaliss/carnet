// M2-01: documents storage. Identical bytes per business dedupe; bytes and sha256 are immutable
// through the repository (no update function), as the app role (privileges) and for any role
// (trigger); the CHECK ties the stored hash to the stored bytes.
import { readFileSync } from "node:fs";
import type { BusinessId } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import * as documentsRepo from "../src/repos/documents";
import {
  getDocument,
  getDocumentContent,
  listDocuments,
  repoCtx,
  sha256Hex,
  storeDocument,
} from "../src/repos/index";
import { hitRateLimit, refundRateLimit } from "../src/repos/rate-limits";
import { createBusiness } from "../src/repos/system";
import { sqlStateOf, useTestDatabase, withClient } from "./harness";

const db = useTestDatabase();
const PERMISSION_DENIED = "42501";
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";

const pdf = new Uint8Array(
  readFileSync(new URL("../../../fixtures/dataset/inv-harbor-001.pdf", import.meta.url)),
);

let docId = "";
let business: BusinessId;

beforeAll(async () => {
  const { app } = db();
  business = await createBusiness(app.db, { name: "docs-co" });
});

describe("storeDocument", () => {
  it("stores bytes with their sha256 and returns identical bytes", async () => {
    const ctx = repoCtx(db().app.db, business);
    const r = await storeDocument(ctx, {
      kind: "invoice",
      filename: "inv-harbor-001.pdf",
      mime: "application/pdf",
      bytes: pdf,
    });
    expect(r.deduplicated).toBe(false);
    expect(r.document.size).toBe(pdf.byteLength);
    expect(r.document.sha256).toBe(sha256Hex(pdf));
    docId = r.document.id;
    const content = await getDocumentContent(ctx, r.document.id);
    expect(content?.bytes).toEqual(pdf);
    expect(sha256Hex(content?.bytes ?? new Uint8Array())).toBe(r.document.sha256);
    expect(await getDocument(ctx, r.document.id)).toEqual(r.document);
  });

  it("identical bytes in the same business return the existing document", async () => {
    const ctx = repoCtx(db().app.db, business);
    const again = await storeDocument(ctx, {
      kind: "other",
      filename: "renamed.pdf",
      mime: "application/pdf",
      bytes: pdf.slice(),
    });
    expect(again.deduplicated).toBe(true);
    expect(again.document.id).toBe(docId);
    expect(again.document.filename).toBe("inv-harbor-001.pdf");
    expect((await listDocuments(ctx)).length).toBe(1);
  });
});

describe("bytes and sha256 are immutable", () => {
  it("the repository has no update or delete path for documents", () => {
    expect(Object.keys(documentsRepo).filter((k) => /update|set|patch|delete/i.test(k))).toEqual(
      [],
    );
  });

  it.each([
    ["bytes", "UPDATE documents SET bytes = '\\x00'::bytea"],
    ["sha256", `UPDATE documents SET sha256 = '${"0".repeat(64)}'`],
    ["size", "UPDATE documents SET size = 1"],
    ["mime", "UPDATE documents SET mime = 'image/png'"],
    ["business_id", "UPDATE documents SET business_id = gen_random_uuid()"],
  ])("as the app role, UPDATE of %s fails with a permission error", async (_c, sql) => {
    expect(await sqlStateOf(db().appUrl, sql)).toBe(PERMISSION_DENIED);
  });

  it("as the app role, kind and filename may change", async () => {
    expect(
      await sqlStateOf(db().appUrl, "UPDATE documents SET kind = 'contract', filename = 'x.pdf'"),
    ).toBeNull();
  });

  it.each([
    [
      "bytes",
      "UPDATE documents SET bytes = '\\x00'::bytea, sha256 = encode(sha256('\\x00'::bytea), 'hex'), size = 1",
    ],
    ["sha256", `UPDATE documents SET sha256 = '${"0".repeat(64)}'`],
  ])("even the owning migration role cannot change %s (trigger)", async (_c, sql) => {
    expect(await sqlStateOf(db().migrationUrl, sql)).toBe(RESTRICT_VIOLATION);
  });

  it("a row whose sha256 is not the hash of its bytes is refused (CHECK)", async () => {
    const state = await sqlStateOf(
      db().appUrl,
      `INSERT INTO documents (business_id, kind, filename, mime, size, sha256, bytes)
       VALUES ('${business}', 'other', 'x.pdf', 'application/pdf', 1, '${"a".repeat(64)}', '\\x00'::bytea)`,
    );
    expect(state).toBe(CHECK_VIOLATION);
  });

  it("the stored bytes are unchanged after every attempt", async () => {
    const stored = await withClient(db().appUrl, async (c) => {
      const r = await c.query<{ sha256: string; ok: boolean }>(
        "SELECT sha256, sha256 = encode(sha256(bytes), 'hex') AS ok FROM documents WHERE id = $1",
        [docId],
      );
      return r.rows[0];
    });
    expect(stored).toEqual({ sha256: sha256Hex(pdf), ok: true });
  });
});

describe("rate limiter amounts (the upload byte cap)", () => {
  it("counts an amount at once and refunds it", async () => {
    const { app } = db();
    const rule = { limit: 100, windowMs: 3_600_000 };
    const now = new Date("2026-11-06T10:00:00Z");
    expect((await hitRateLimit(app.db, "documents-bytes", rule, now, 60)).allowed).toBe(true);
    const over = await hitRateLimit(app.db, "documents-bytes", rule, now, 41);
    expect(over).toMatchObject({ count: 101, allowed: false });
    await refundRateLimit(app.db, "documents-bytes", rule, now, 41);
    expect((await hitRateLimit(app.db, "documents-bytes", rule, now, 40)).count).toBe(100);
    await expect(hitRateLimit(app.db, "documents-bytes", rule, now, 0)).rejects.toThrow(RangeError);
  });
});
