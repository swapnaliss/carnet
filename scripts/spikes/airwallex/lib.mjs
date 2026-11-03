// Shared recorder for the M0-03/M0-04 Airwallex sandbox spikes. Dependency-free.
// Reads credentials from the process environment only. Never prints header values, tokens or keys;
// fixtures are written with tokens, Authorization and the API key stripped.

import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, "..", "..", "..", "fixtures", "airwallex");

export const env = {
  clientId: process.env.AIRWALLEX_CLIENT_ID ?? "",
  apiKey: process.env.AIRWALLEX_API_KEY ?? "",
  base: process.env.AIRWALLEX_BASE_URL ?? "https://api.sandbox.airwallex.com",
  filesBase: process.env.AIRWALLEX_FILES_URL ?? "https://files.sandbox.airwallex.com",
};

export function requireEnv() {
  if (!env.clientId || !env.apiKey) {
    console.error("missing sandbox env: AIRWALLEX_CLIENT_ID and AIRWALLEX_API_KEY");
    process.exit(2);
  }
  if (!/sandbox/.test(env.base)) {
    console.error("refusing to run: AIRWALLEX_BASE_URL is not a sandbox host");
    process.exit(2);
  }
}

const SECRET_KEYS =
  /^(token|access_token|refresh_token|api_key|client_secret|authorization|x-api-key|x-client-id)$/i;
const secretValues = () =>
  [env.apiKey, env.clientId, process.env.CANARY_SECRET, token].filter((v) => v && v.length >= 6);

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_KEYS.test(k) && typeof v === "string" ? "<redacted>" : redact(v),
      ]),
    );
  }
  if (typeof value === "string") {
    let s = value;
    for (const sv of secretValues()) s = s.split(sv).join("<redacted>");
    return s;
  }
  return value;
}

let token = "";
let tokenExpiresAt = 0;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const newId = () => randomUUID();

export function record(name, data) {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  writeFileSync(join(FIXTURE_DIR, `${name}.json`), `${JSON.stringify(redact(data), null, 2)}\n`);
}

async function raw(
  method,
  base,
  path,
  { body, headers = {}, auth = true, timeoutMs = 20000 } = {},
) {
  const h = { ...headers };
  if (auth) h.Authorization = `Bearer ${await getToken()}`;
  const isForm = body instanceof FormData;
  if (body !== undefined && !isForm) h["Content-Type"] = "application/json";
  const started = Date.now();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const keep = [
    "content-type",
    "retry-after",
    "x-request-id",
    "x-ratelimit-limit",
    "x-ratelimit-remaining",
    "x-ratelimit-reset",
    "x-awx-request-id",
  ];
  const resHeaders = Object.fromEntries(
    [...res.headers].filter(([k]) => keep.includes(k.toLowerCase())),
  );
  return {
    status: res.status,
    ms: Date.now() - started,
    headers: resHeaders,
    body: json ?? text,
    reqBody: isForm ? "<multipart>" : body,
  };
}

async function getToken(force = false) {
  if (!force && token && Date.now() < tokenExpiresAt - 60_000) return token;
  const r = await raw("POST", env.base, "/api/v1/authentication/login", {
    auth: false,
    headers: { "x-client-id": env.clientId, "x-api-key": env.apiKey },
  });
  if (r.status !== 201 && r.status !== 200) throw new Error(`login failed: ${r.status}`);
  token = r.body.token;
  tokenExpiresAt = Date.parse(r.body.expires_at) || Date.now() + 25 * 60_000;
  return token;
}
export const invalidateToken = () => {
  token = "";
  tokenExpiresAt = 0;
};
export const setTokenForTest = (t) => {
  token = t;
  tokenExpiresAt = Date.now() + 10 * 60_000;
};
export { getToken };

// Call, record a fixture (request and response, redacted), print one status line, return the result.
export async function call(name, method, path, opts = {}) {
  const base = opts.files ? env.filesBase : env.base;
  const r = await raw(method, base, path, opts);
  if (!name.startsWith("tmp-"))
    record(name, {
      method,
      path,
      request: opts.body === undefined ? undefined : r.reqBody,
      requestHeaders: opts.headers,
      response: { status: r.status, headers: r.headers, body: r.body },
    });
  if (!name.startsWith("tmp-"))
    console.log(`${name}: ${method} ${path.split("?")[0]} -> ${r.status} (${r.ms} ms)`);
  return r;
}

export function must(r, ...ok) {
  const allowed = ok.length ? ok : [200, 201];
  if (!allowed.includes(r.status))
    throw new Error(
      `unexpected status ${r.status}: ${JSON.stringify(redact(r.body)).slice(0, 400)}`,
    );
  return r.body;
}
