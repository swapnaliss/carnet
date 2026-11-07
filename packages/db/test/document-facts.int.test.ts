// M2-02: document_facts storage. Versions are immutable (no repository path, no app-role UPDATE or
// DELETE, a trigger for every role), the usable view returns only verified or owner-confirmed facts,
// and every read is scoped by business.
import { readFileSync } from "node:fs";
import type { BusinessId, DocumentId, ExtractedFact } from "@carnet/domain";
import { FACT_VERSION_SOURCES, FACT_VERSION_STATUSES } from "@carnet/domain";
import { beforeAll, describe, expect, it } from "vitest";
import * as factsRepo from "../src/repos/document-facts";
import {
  getFactsVersion,
  getLatestFacts,
  getUsableFacts,
  insertFactsVersion,
  listFactVersions,
} from "../src/repos/document-facts";
import { repoCtx, storeDocument } from "../src/repos/index";
import { createBusiness } from "../src/repos/system";
import { createUser } from "../src/repos/users";
import {
  FACT_VERSION_SOURCE_VALUES,
  FACT_VERSION_STATUS_VALUES,
} from "../src/schema/document-facts";
import { sqlStateOf, useTestDatabase } from "./harness";

const db = useTestDatabase();
const PERMISSION_DENIED = "42501";
const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

const bytes = new Uint8Array(
  readFileSync(new URL("../../../fixtures/dataset/inv-harbor-001.pdf", import.meta.url)),
);

const fact = (over: Partial<ExtractedFact> = {}): ExtractedFact => ({
  key: "total",
  value: "USD 4,800.00",
  parsed: { type: "amount", minor: "480000", currency: "USD" },
  quote: "Total due: USD 4,800.00",
  page: 1,
  quote_verified: true,
  needs_confirmation: false,
  issues: [],
  ...over,
});
const unverified = fact({ key: "buyer", quote_verified: false, issues: ["quote_not_found"] });
const scanFact = fact({
  key: "supplier",
  quote_verified: false,
  needs_confirmation: true,
  issues: ["no_text_layer"],
});

let business: BusinessId;
let other: BusinessId;
let doc: DocumentId;
let owner: string;

beforeAll(async () => {
  const { app } = db();
  business = await createBusiness(app.db, { name: "facts-co" });
  other = await createBusiness(app.db, { name: "other-co" });
  const ctx = repoCtx(app.db, business);
  doc = (
    await storeDocument(ctx, {
      kind: "invoice",
      filename: "inv.pdf",
      mime: "application/pdf",
      bytes,
    })
  ).document.id;
  owner = (
    await createUser(ctx, { email: "owner@facts.example.com", name: "Owner", role: "owner" })
  ).id;
});

const model = (over: Partial<Parameters<typeof insertFactsVersion>[1]> = {}) => ({
  documentId: doc,
  source: "model" as const,
  status: "EXTRACTED" as const,
  promptVersion: "pv1",
  model: "claude-haiku-5-5",
  textLayer: true,
  facts: [fact(), unverified],
  ...over,
});

describe("versions", () => {
  it("numbers versions per document from 1, idempotently per extraction key", async () => {
    const ctx = repoCtx(db().app.db, business);
    const a = await insertFactsVersion(ctx, model({ extractionKey: "job-1" }));
    expect(a.inserted).toBe(true);
    expect(a.version.version).toBe(1);
    expect(a.version.quotesVerified).toBe(false); // one fact is unverified
    expect(a.version.quotes.map((q) => q.key)).toEqual(["total", "buyer"]);

    const again = await insertFactsVersion(ctx, model({ extractionKey: "job-1" }));
    expect(again.inserted).toBe(false);
    expect(again.version.id).toBe(a.version.id);

    const b = await insertFactsVersion(ctx, model({ extractionKey: "job-2", facts: [fact()] }));
    expect(b.version.version).toBe(2);
    expect(b.version.quotesVerified).toBe(true);
    expect((await listFactVersions(ctx, doc)).map((v) => v.version)).toEqual([2, 1]);
    expect((await getLatestFacts(ctx, doc))?.version).toBe(2);
    expect((await getFactsVersion(ctx, doc, 1))?.id).toBe(a.version.id);
    expect(await getFactsVersion(ctx, doc, 9)).toBeNull();
  });

  it("two concurrent inserts get different version numbers", async () => {
    const ctx = repoCtx(db().app.db, business);
    const before = (await getLatestFacts(ctx, doc))?.version ?? 0;
    const [x, y] = await Promise.all([
      insertFactsVersion(ctx, model({ extractionKey: "race-a" })),
      insertFactsVersion(ctx, model({ extractionKey: "race-b" })),
    ]);
    expect([x.version.version, y.version.version].sort()).toEqual([before + 1, before + 2]);
  });
});

describe("the usable view", () => {
  it("returns only verified facts of a model version", async () => {
    const ctx = repoCtx(db().app.db, business);
    await insertFactsVersion(
      ctx,
      model({ extractionKey: "usable-1", facts: [fact(), unverified, scanFact] }),
    );
    const usable = await getUsableFacts(ctx, doc);
    expect(usable?.confirmed).toBe(false);
    expect(usable?.facts.map((f) => f.key)).toEqual(["total"]);
  });

  it("returns nothing from an image-only version until an owner confirms (and stores who)", async () => {
    const ctx = repoCtx(db().app.db, business);
    const scanned = await insertFactsVersion(
      ctx,
      model({
        extractionKey: "scan",
        textLayer: false,
        facts: [scanFact, { ...scanFact, key: "total" }],
      }),
    );
    expect((await getUsableFacts(ctx, doc))?.facts).toEqual([]);
    const confirmed = await insertFactsVersion(ctx, {
      documentId: doc,
      source: "owner",
      status: "EXTRACTED",
      textLayer: false,
      facts: scanned.version.facts.map((f) => ({ ...f, needs_confirmation: false })),
      ownerConfirmedBy: owner,
    });
    expect(confirmed.version.version).toBe(scanned.version.version + 1);
    expect(confirmed.version.ownerConfirmedBy).toBe(owner);
    const usable = await getUsableFacts(ctx, doc);
    expect(usable).toMatchObject({ confirmed: true, version: confirmed.version.version });
    expect(usable?.facts).toHaveLength(2);
  });

  it("a failed extraction yields no facts and a typed failure", async () => {
    const ctx = repoCtx(db().app.db, business);
    const failed = await insertFactsVersion(ctx, {
      documentId: doc,
      source: "model",
      status: "EXTRACTION_FAILED",
      failure: "AGENTS_DISABLED",
      extractionKey: "failed",
      textLayer: true,
      facts: [],
    });
    expect(failed.version).toMatchObject({
      status: "EXTRACTION_FAILED",
      failure: "AGENTS_DISABLED",
      facts: [],
    });
    expect((await getUsableFacts(ctx, doc))?.facts).toEqual([]);
  });

  it("is null for a document with no version", async () => {
    const ctx = repoCtx(db().app.db, business);
    const fresh = await storeDocument(ctx, {
      kind: "invoice",
      filename: "other.pdf",
      mime: "application/pdf",
      bytes: new Uint8Array([...bytes, 10]),
    });
    expect(await getUsableFacts(ctx, fresh.document.id)).toBeNull();
  });
});

describe("AC4: versions are immutable", () => {
  it("the repository has no update or delete path", () => {
    expect(Object.keys(factsRepo).filter((k) => /update|set|patch|delete|remove/i.test(k))).toEqual(
      [],
    );
  });

  it.each([
    ["UPDATE", "UPDATE document_facts SET quotes_verified = NOT quotes_verified"],
    ["UPDATE of facts", "UPDATE document_facts SET facts = '[]'::jsonb"],
    ["DELETE", "DELETE FROM document_facts"],
  ])("as the app role, %s fails with a permission error", async (_c, sql) => {
    expect(await sqlStateOf(db().appUrl, sql)).toBe(PERMISSION_DENIED);
  });

  it.each([
    ["UPDATE", "UPDATE document_facts SET quotes_verified = NOT quotes_verified"],
    ["DELETE", "DELETE FROM document_facts"],
  ])("even the owning migration role cannot %s (trigger)", async (_c, sql) => {
    expect(await sqlStateOf(db().migrationUrl, sql)).toBe(RESTRICT_VIOLATION);
  });

  it("the versions are all still there", async () => {
    const ctx = repoCtx(db().app.db, business);
    expect((await listFactVersions(ctx, doc)).length).toBeGreaterThanOrEqual(6);
  });
});

describe("constraints", () => {
  const insert = (cols: string, vals: string) =>
    sqlStateOf(
      db().appUrl,
      `INSERT INTO document_facts (business_id, document_id, version, ${cols}, text_layer, facts, quotes, quotes_verified)
       VALUES ('${business}', '${doc}', 900, ${vals}, true, '[]', '[]', false)`,
    );
  it("a failed status needs a failure reason, a model status must not have one", async () => {
    expect(await insert("source, status", "'model', 'EXTRACTION_FAILED'")).toBe(CHECK_VIOLATION);
    expect(await insert("source, status, failure", "'model', 'EXTRACTED', 'X'")).toBe(
      CHECK_VIOLATION,
    );
  });
  it("an owner version needs the confirming user, a model version must not have one", async () => {
    expect(await insert("source, status", "'owner', 'EXTRACTED'")).toBe(CHECK_VIOLATION);
    expect(
      await insert("source, status, owner_confirmed_by", `'model', 'EXTRACTED', '${owner}'`),
    ).toBe(CHECK_VIOLATION);
  });
  it("the status and source sets mirror the domain", () => {
    expect([...FACT_VERSION_SOURCE_VALUES]).toEqual([...FACT_VERSION_SOURCES]);
    expect([...FACT_VERSION_STATUS_VALUES]).toEqual([...FACT_VERSION_STATUSES]);
  });
});

describe("AC9: tenancy", () => {
  it("another business reads nothing of this document's facts", async () => {
    const ctx = repoCtx(db().app.db, other);
    expect(await getLatestFacts(ctx, doc)).toBeNull();
    expect(await getFactsVersion(ctx, doc, 1)).toBeNull();
    expect(await listFactVersions(ctx, doc)).toEqual([]);
    expect(await getUsableFacts(ctx, doc)).toBeNull();
  });
  it("another business cannot attach facts to this document (composite key)", async () => {
    const ctx = repoCtx(db().app.db, other);
    await expect(insertFactsVersion(ctx, model())).rejects.toMatchObject({
      name: "ForeignKeyViolationError",
    });
    expect(
      await sqlStateOf(
        db().appUrl,
        `INSERT INTO document_facts (business_id, document_id, version, source, status, text_layer, facts, quotes, quotes_verified)
         VALUES ('${other}', '${doc}', 1, 'model', 'EXTRACTED', true, '[]', '[]', false)`,
      ),
    ).toBe(FK_VIOLATION);
  });
});
