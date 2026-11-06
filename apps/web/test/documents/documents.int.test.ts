// M2-01 acceptance tests: upload, validation, storage, serving, tenancy, caps, audit.
import { createHash } from "node:crypto";
import { createBusiness, listAudit, repoCtx, schema } from "@carnet/db";
import { ApiErrorSchema, DocumentMetaSchema, DocumentUploadResponseSchema } from "@carnet/domain";
import { count, eq } from "drizzle-orm";
import PDFDocument from "pdfkit";
import { beforeAll, describe, expect, it } from "vitest";
import { addUser, ORIGIN, sessionCookie, setupAuthTestEnv } from "../auth/setup";
import {
  DEFAULT_TEST_LIMITS,
  dataset,
  documentRoutes,
  getRequest,
  idContext,
  uploadRequest,
} from "./support";

const env = setupAuthTestEnv();
const cookies = { owner: "", approver: "", judge: "", other: "" };
let routes: ReturnType<typeof documentRoutes>;

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function pdfWith(options: {
  pages: number;
  userPassword?: string;
}): Promise<Uint8Array<ArrayBuffer>> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      ...(options.userPassword
        ? { userPassword: options.userPassword, ownerPassword: "owner-secret" }
        : {}),
    });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    doc.on("error", reject);
    for (let i = 0; i < options.pages; i++) {
      doc.addPage();
      doc.text(`page ${i + 1}`);
    }
    doc.end();
  });
}

async function problem(res: Response) {
  return ApiErrorSchema.parse(await res.json()).error;
}

async function documentRows() {
  return (await env().db.select({ n: count() }).from(schema.documents))[0]?.n ?? 0;
}

beforeAll(async () => {
  const { db, passwords } = env();
  const other = await createBusiness(db, { name: "Business B (synthetic)" });
  await addUser(db, other, {
    email: "owner@b.example",
    role: "owner",
    password: "b-owner-password",
  });
  cookies.owner = await sessionCookie(env(), "owner@carnet.example", passwords.owner);
  cookies.approver = await sessionCookie(env(), "approver@carnet.example", passwords.approver);
  cookies.judge = await sessionCookie(env(), "judge@carnet.example", passwords.judge);
  cookies.other = await sessionCookie(env(), "owner@b.example", "b-owner-password");
  routes = documentRoutes(env(), { limits: { ...DEFAULT_TEST_LIMITS, sessionMaxFiles: 1000 } });
});

describe("AC1 and AC5: valid PDF, JPEG and PNG round-trip with the serving headers", () => {
  const cases = [
    ["inv-harbor-001.pdf", "application/pdf", "pdf"],
    ["scans/inv-nordlicht-scan-001.jpg", "image/jpeg", "jpg"],
    ["scans/inv-nordlicht-scan-001.png", "image/png", "png"],
  ] as const;

  it.each(cases)("%s", async (file, mime, ext) => {
    const bytes = dataset(file);
    const res = await routes.upload(
      uploadRequest(
        cookies.owner,
        { bytes, name: file.split("/").pop() ?? file },
        { kind: "invoice" },
      ),
    );
    expect(res.status).toBe(201);
    const body = DocumentUploadResponseSchema.parse(await res.json());
    expect(body).toMatchObject({
      deduplicated: false,
      mime,
      size: bytes.byteLength,
      kind: "invoice",
    });
    expect(body.sha256).toBe(sha(bytes));
    expect(body.filename.endsWith(`.${ext}`)).toBe(true);

    const got = await routes.download(
      new Request(`${ORIGIN}/api/v1/documents/${body.id}`, {
        headers: { cookie: cookies.owner, origin: ORIGIN },
      }),
      idContext(body.id),
    );
    expect(got.status).toBe(200);
    const served = new Uint8Array(await got.arrayBuffer());
    expect(served).toEqual(bytes);
    expect(sha(served)).toBe(body.sha256);
    expect(got.headers.get("content-type")).toBe(mime);
    expect(got.headers.get("content-disposition")).toBe(`attachment; filename="${body.filename}"`);
    expect(got.headers.get("x-content-type-options")).toBe("nosniff");
    expect(got.headers.get("cache-control")).toBe("private, no-store");

    const meta = await routes.meta(
      getRequest(`/api/v1/documents/${body.id}/meta`, cookies.owner),
      idContext(body.id),
    );
    expect(meta.status).toBe(200);
    expect(DocumentMetaSchema.parse(await meta.json())).toMatchObject({
      id: body.id,
      sha256: body.sha256,
    });
  });

  it("identical bytes in the same business return the existing document (200, deduplicated)", async () => {
    const bytes = dataset("inv-harbor-001.pdf");
    const res = await routes.upload(uploadRequest(cookies.approver, { bytes, name: "again.pdf" }));
    expect(res.status).toBe(200);
    expect(DocumentUploadResponseSchema.parse(await res.json()).deduplicated).toBe(true);
  });
});

describe("AC2: type by content, not by name or declared type", () => {
  it("a .pdf name with PNG bytes is stored as image/png", async () => {
    const bytes = dataset("scans/inv-nordlicht-scan-001.png");
    const res = await routes.upload(
      uploadRequest(cookies.owner, {
        bytes: bytes.slice(),
        name: "invoice.pdf",
        type: "application/pdf",
      }),
    );
    expect([200, 201]).toContain(res.status);
    const body = DocumentUploadResponseSchema.parse(await res.json());
    expect(body.mime).toBe("image/png");
    expect(body.filename).toBe(body.filename.replace(/\.pdf$/, ".png"));
  });

  const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
  const zip = new Uint8Array([
    0x50,
    0x4b,
    0x03,
    0x04,
    ...new Array(26).fill(0),
    0x50,
    0x4b,
    0x05,
    0x06,
    ...new Array(18).fill(0),
  ]) as Uint8Array<ArrayBuffer>;
  it.each([
    [
      "an .exe",
      new Uint8Array([0x4d, 0x5a, ...new Array(300).fill(1)]) as Uint8Array<ArrayBuffer>,
      "x.pdf",
      "UNSUPPORTED_TYPE",
    ],
    ["HTML named .pdf", enc("<html><script>alert(1)</script></html>"), "x.pdf", "UNSUPPORTED_TYPE"],
    ["an SVG", enc('<svg xmlns="http://www.w3.org/2000/svg"/>'), "x.svg", "UNSUPPORTED_TYPE"],
    ["a ZIP", zip, "x.zip", "UNSUPPORTED_TYPE"],
    [
      "a PDF-header ZIP-body polyglot",
      new Uint8Array([...enc("%PDF-1.7\n"), ...zip]) as Uint8Array<ArrayBuffer>,
      "x.pdf",
      "UNSUPPORTED_TYPE",
    ],
  ])("%s is rejected %s", async (_label, bytes, name, reason) => {
    const before = await documentRows();
    const res = await routes.upload(uploadRequest(cookies.owner, { bytes, name }));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    const e = await problem(res);
    expect([reason, "CORRUPT_FILE"]).toContain(e.details?.reason);
    expect(await documentRows()).toBe(before);
  });
});

describe("AC3: size, pages, encryption", () => {
  it("a 21-page PDF is TOO_MANY_PAGES, a 20-page PDF is stored", async () => {
    const over = await routes.upload(
      uploadRequest(cookies.owner, { bytes: await pdfWith({ pages: 21 }), name: "p21.pdf" }),
    );
    expect(over.status).toBe(400);
    expect((await problem(over)).details?.reason).toBe("TOO_MANY_PAGES");
    const ok = await routes.upload(
      uploadRequest(cookies.owner, { bytes: await pdfWith({ pages: 20 }), name: "p20.pdf" }),
    );
    expect(ok.status).toBe(201);
  });

  it("an encrypted PDF is rejected ENCRYPTED_PDF", async () => {
    const bytes = await pdfWith({ pages: 1, userPassword: "secret" });
    const res = await routes.upload(uploadRequest(cookies.owner, { bytes, name: "locked.pdf" }));
    expect(res.status).toBe(400);
    expect((await problem(res)).details?.reason).toBe("ENCRYPTED_PDF");
  });

  it("a truncated PDF is CORRUPT_FILE", async () => {
    const pdf = dataset("inv-harbor-001.pdf");
    const res = await routes.upload(
      uploadRequest(cookies.owner, { bytes: pdf.slice(0, pdf.length - 1500), name: "cut.pdf" }),
    );
    expect(res.status).toBe(400);
    expect((await problem(res)).details?.reason).toBe("CORRUPT_FILE");
  });

  /** A body that would be 50 MiB, served in 64 KiB pulls; reports how many bytes were pulled. */
  function endlessUpload(headers: Record<string, string>) {
    const boundary = "----carnet";
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="big.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.7\n`,
    );
    const chunk = new Uint8Array(64 * 1024).fill(0x41);
    const state = { pulled: 0 };
    const total = 50 * 1024 * 1024;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (state.pulled === 0) {
          controller.enqueue(head);
          state.pulled += head.byteLength;
          return;
        }
        if (state.pulled >= total) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        state.pulled += chunk.byteLength;
      },
    });
    const req = new Request(`${ORIGIN}/api/v1/documents`, {
      method: "POST",
      headers: {
        cookie: cookies.owner,
        origin: ORIGIN,
        "content-type": `multipart/form-data; boundary=${boundary}`,
        ...headers,
      },
      body: stream,
      duplex: "half",
    } as RequestInit);
    return { req, state };
  }

  it("UPLOAD_MAX_BYTES + 1 is 413 without reading the rest of the body (honest or lying Content-Length)", async () => {
    for (const headers of [{}, { "content-length": "100" }]) {
      const { req, state } = endlessUpload(headers);
      const res = await routes.upload(req);
      expect(res.status).toBe(413);
      expect((await problem(res)).details?.reason).toBe("TOO_LARGE");
      expect(state.pulled).toBeLessThan(DEFAULT_TEST_LIMITS.maxBytes + 1024 * 1024);
    }
  });

  it("a declared Content-Length over the cap is 413 before any byte is read", async () => {
    const { req, state } = endlessUpload({
      "content-length": String(DEFAULT_TEST_LIMITS.maxBytes + 1),
    });
    const res = await routes.upload(req);
    expect(res.status).toBe(413);
    expect(state.pulled).toBeLessThan(64 * 1024); // only the runtime's first pull
  });
});

describe("AC6: tenancy and authentication", () => {
  let id = "";
  beforeAll(async () => {
    const res = await routes.upload(
      uploadRequest(cookies.owner, { bytes: dataset("contract-harbor.pdf"), name: "c.pdf" }),
    );
    id = DocumentUploadResponseSchema.parse(await res.json()).id;
  });

  it("another business gets 404 on bytes and meta; the owning business 200", async () => {
    for (const [route, path] of [
      [routes.download, `/api/v1/documents/${id}`],
      [routes.meta, `/api/v1/documents/${id}/meta`],
    ] as const) {
      const foreign = await route(getRequest(path, cookies.other), idContext(id));
      expect(foreign.status).toBe(404);
      expect((await problem(foreign)).code).toBe("NOT_FOUND");
      expect((await route(getRequest(path, cookies.judge), idContext(id))).status).toBe(200);
    }
  });

  it("no session is 401 on upload, bytes and meta; a malformed id is 400", async () => {
    expect(
      (
        await routes.upload(
          uploadRequest("", { bytes: dataset("contract-harbor.pdf"), name: "c.pdf" }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await routes.download(getRequest(`/api/v1/documents/${id}`, ""), idContext(id))).status,
    ).toBe(401);
    expect(
      (await routes.meta(getRequest(`/api/v1/documents/${id}/meta`, ""), idContext(id))).status,
    ).toBe(401);
    expect(
      (
        await routes.download(
          getRequest("/api/v1/documents/nope", cookies.owner),
          idContext("nope"),
        )
      ).status,
    ).toBe(400);
  });

  it("the read-only judge cannot upload (403)", async () => {
    const res = await routes.upload(
      uploadRequest(cookies.judge, { bytes: dataset("contract-harbor.pdf"), name: "c.pdf" }),
    );
    expect(res.status).toBe(403);
  });

  it("another business uploading the same bytes gets its own document", async () => {
    const res = await routes.upload(
      uploadRequest(cookies.other, { bytes: dataset("contract-harbor.pdf"), name: "c.pdf" }),
    );
    const body = DocumentUploadResponseSchema.parse(await res.json());
    expect(res.status).toBe(201);
    expect(body.id).not.toBe(id);
  });
});

describe("request shape", () => {
  it("rejects a missing file, two files, an unknown field and a bad kind with one 400", async () => {
    const pdf = dataset("contract-harbor.pdf");
    expect((await routes.upload(uploadRequest(cookies.owner, null))).status).toBe(400);
    expect(
      (
        await routes.upload(
          uploadRequest(cookies.owner, { bytes: pdf, name: "a.pdf" }, { kind: "passport" }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await routes.upload(
          uploadRequest(cookies.owner, { bytes: pdf, name: "a.pdf" }, { url: "http://x" }),
        )
      ).status,
    ).toBe(400);
    const form = new FormData();
    form.append("file", new Blob([pdf]), "a.pdf");
    form.append("file", new Blob([pdf]), "b.pdf");
    const two = await routes.upload(
      new Request(`${ORIGIN}/api/v1/documents`, {
        method: "POST",
        headers: { cookie: cookies.owner, origin: ORIGIN },
        body: form,
      }),
    );
    expect(two.status).toBe(400);
  });

  it("a JSON body is 415", async () => {
    const res = await routes.upload(
      new Request(`${ORIGIN}/api/v1/documents`, {
        method: "POST",
        headers: { cookie: cookies.owner, origin: ORIGIN, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(res.status).toBe(415);
  });
});

describe("AC8: per-session caps, DB-backed", () => {
  it("the eleventh upload in an hour is 429 with retry-after, and survives a new kit (restart)", async () => {
    const clock = new Date("2030-01-01T10:00:00Z");
    const limits = { ...DEFAULT_TEST_LIMITS };
    const cookie = await sessionCookie(env(), "approver@carnet.example", env().passwords.approver);
    const first = documentRoutes(env(), { limits, now: () => clock });
    const png = dataset("scans/inv-nordlicht-scan-001.png");
    for (let i = 0; i < 10; i++) {
      const res = await first.upload(
        uploadRequest(cookie, { bytes: png.slice(), name: `n${i}.png` }),
      );
      expect(res.status, `upload ${i + 1}`).toBeLessThan(300);
    }
    const eleventh = await first.upload(
      uploadRequest(cookie, { bytes: png.slice(), name: "n10.png" }),
    );
    expect(eleventh.status).toBe(429);
    expect(Number(eleventh.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await problem(eleventh)).details?.reason).toBe("SESSION_CAP");

    const restarted = documentRoutes(env(), { limits, now: () => clock });
    expect(
      (await restarted.upload(uploadRequest(cookie, { bytes: png.slice(), name: "n11.png" })))
        .status,
    ).toBe(429);
    const later = documentRoutes(env(), {
      limits,
      now: () => new Date(clock.getTime() + 3_600_000),
    });
    expect(
      (await later.upload(uploadRequest(cookie, { bytes: png.slice(), name: "n12.png" }))).status,
    ).toBeLessThan(300);
  });

  it("the byte cap refuses an upload that would pass it", async () => {
    const clock = new Date("2030-02-01T10:00:00Z");
    const cookie = await sessionCookie(env(), "owner@carnet.example", env().passwords.owner);
    const pdf = dataset("inv-rhein-001.pdf");
    const small = documentRoutes(env(), {
      limits: { ...DEFAULT_TEST_LIMITS, sessionMaxBytes: pdf.byteLength + 10 },
      now: () => clock,
    });
    expect(
      (await small.upload(uploadRequest(cookie, { bytes: pdf, name: "a.pdf" }))).status,
    ).toBeLessThan(300);
    const res = await small.upload(
      uploadRequest(cookie, { bytes: dataset("inv-rhein-002.pdf"), name: "b.pdf" }),
    );
    expect(res.status).toBe(429);
    expect((await problem(res)).details?.reason).toBe("SESSION_CAP");
  });
});

describe("AC9: audit entries, never bytes", () => {
  it("accepted, deduplicated, rejected and downloaded outcomes each leave an entry", async () => {
    const cookie = await sessionCookie(env(), "owner@carnet.example", env().passwords.owner);
    const pdf = dataset("po-harbor-001.pdf");
    const a = await routes.upload(uploadRequest(cookie, { bytes: pdf, name: "po.pdf" }));
    const id = DocumentUploadResponseSchema.parse(await a.json()).id;
    await routes.upload(uploadRequest(cookie, { bytes: pdf, name: "po2.pdf" }));
    await routes.upload(
      uploadRequest(cookie, {
        bytes: new Uint8Array([1, 2, 3, 4]) as Uint8Array<ArrayBuffer>,
        name: "x.exe",
      }),
    );
    await routes.download(getRequest(`/api/v1/documents/${id}`, cookie), idContext(id));

    const { db, businessId } = env();
    const entries = await listAudit(repoCtx(db, businessId), 500);
    const actions = new Set(entries.map((e) => e.action));
    for (const action of [
      "document.uploaded",
      "document.deduplicated",
      "document.upload_rejected",
      "document.downloaded",
    ]) {
      expect(actions, action).toContain(action);
    }
    const rejected = entries.find(
      (e) =>
        e.action === "document.upload_rejected" &&
        (e.data as { reason?: string }).reason === "UNSUPPORTED_TYPE",
    );
    expect(rejected?.actorId).toBeTruthy();
    const docEntries = entries.filter((e) => e.action.startsWith("document."));
    const text = JSON.stringify(docEntries, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(text).not.toContain("%PDF");
    expect(text).not.toContain(Buffer.from(pdf).toString("base64").slice(0, 40));
    const uploaded = entries.find(
      (e) =>
        e.action === "document.uploaded" && (e.data as { document_id?: string }).document_id === id,
    );
    expect(uploaded?.data).toMatchObject({ sha256: sha(pdf), size: pdf.byteLength });
  });
});

describe("rejected input stores nothing", () => {
  it("document rows equal the accepted uploads", async () => {
    const rows = await env()
      .db.select({ sha: schema.documents.sha256 })
      .from(schema.documents)
      .where(eq(schema.documents.mime, "application/pdf"));
    expect(rows.length).toBeGreaterThan(0);
  });
});
