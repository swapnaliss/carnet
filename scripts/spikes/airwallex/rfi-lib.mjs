// RFI helpers for the M0-04 spike. Reuses the M0-03 recorder; credentials from the environment only.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { newTransfer } from "./04-transitions.mjs";
import { call, FIXTURE_DIR, sleep } from "./lib.mjs";

export const RFI_BASE = "/api/v1/rfis";
const here = dirname(fileURLToPath(import.meta.url));
void here;

// Beneficiary ids come from the committed M0-03 fixtures (the beneficiaries still exist on the account).
export function beneficiaryIds() {
  const id = (f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")).response.body.id;
  return {
    us: id("beneficiary-create-us-usd-local.json"),
    de: id("beneficiary-create-de-eur-swift.json"),
  };
}

export async function listOpenRfis() {
  const out = [];
  for (const status of ["ACTION_REQUIRED", "ANSWERED"]) {
    const r = await call(
      `tmp-rfi-list-${status}`,
      "GET",
      `${RFI_BASE}?statuses=${status}&types=TRANSACTION&page_size=100`,
    );
    out.push(...(r.body?.items ?? []));
  }
  return out;
}

// One open Transaction RFI at a time: close whatever is open before a check starts.
export async function closeAllOpenRfis() {
  const open = await listOpenRfis();
  for (const rfi of open) {
    await call(`tmp-rfi-close-${rfi.id}`, "POST", `/api/v1/simulation/rfis/${rfi.id}/close`, {
      body: {},
    });
  }
  if (open.length) await sleep(500);
  return open.length;
}

export const question = (type, title, description = "Spike question") => ({
  answer: { type },
  title: { en: title },
  description: { en: description },
});

export async function freshTransfer(name, amount = 20) {
  const t = await newTransfer(name, beneficiaryIds().us, "USD", "LOCAL", amount);
  for (let i = 0; i < 15; i++) {
    const r = await call("tmp-wait", "GET", `/api/v1/transfers/${t.id}`);
    if (r.body.status === "PROCESSING") break;
    await sleep(1000);
  }
  return t;
}

export function createRfi(name, { transferIds = [], questions }) {
  return call(name, "POST", "/api/v1/simulation/rfis/create", {
    body: {
      type: "TRANSACTION",
      questions: questions.map((q) => ({
        ...q,
        ...(transferIds.length
          ? { sources: transferIds.map((id) => ({ id, type: "TRANSFER" })) }
          : {}),
      })),
    },
  });
}
export const getRfi = (name, id) => call(name, "GET", `${RFI_BASE}/${id}`);
export const getTransfer = (name, id) => call(name, "GET", `/api/v1/transfers/${id}`);
export const closeRfi = (name, id) =>
  call(name, "POST", `/api/v1/simulation/rfis/${id}/close`, { body: {} });
export const respond = (name, id, questions) =>
  call(name, "POST", `${RFI_BASE}/${id}/respond`, { body: { questions } });

export async function upload(name, bytes, filename, mime) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);
  return call(name, "POST", "/api/v1/files/upload", { files: true, body: form, timeoutMs: 90000 });
}

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=",
  "base64",
);
export const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
);
