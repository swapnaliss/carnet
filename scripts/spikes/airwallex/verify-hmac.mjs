// Offline check of recorded webhook deliveries (M0-05). Secret from AIRWALLEX_WEBHOOK_SECRET; never printed.
// Construction (observed): x-signature = hex(HMAC_SHA256(secret, x-timestamp + rawBody)); x-timestamp is epoch ms.
// Freshness policy to implement in M1-05: |receipt time - x-timestamp| <= TOLERANCE_MS.
//   --dir <d>                  fixtures directory (files with `headers` and `body_utf8`; names starting `_` are skipped)
//   (default)  --expect-valid  every fixture must verify and be fresh at its recorded receipt time
//   --tamper   --expect-invalid  flip one byte of the body; the recorded signature must fail
//   --stale    --expect-invalid  re-sign with a timestamp 10 minutes before receipt; signature is valid, freshness must fail
import { createHmac, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const TOLERANCE_MS = 5 * 60 * 1000;
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const dir = args[args.indexOf("--dir") + 1];
const secret = process.env.AIRWALLEX_WEBHOOK_SECRET;
if (!secret || !dir) {
  console.error(
    "usage: AIRWALLEX_WEBHOOK_SECRET=... verify-hmac.mjs --dir <d> [--tamper|--stale] --expect-valid|--expect-invalid",
  );
  process.exit(2);
}

export const sign = (ts, raw) =>
  createHmac("sha256", secret).update(String(ts)).update(raw).digest("hex");
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function verify({ headers, raw, receivedAtMs, signature, timestamp }) {
  const sigOk = same(sign(timestamp, raw), signature);
  const age = receivedAtMs - Number(timestamp);
  const fresh = Math.abs(age) <= TOLERANCE_MS;
  return { sigOk, fresh, ageMs: age, ok: sigOk && fresh };
}

const files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
let okCount = 0;
let badCount = 0;
for (const f of files) {
  const d = JSON.parse(readFileSync(join(dir, f), "utf8"));
  const receivedAtMs = Date.parse(d.received_at);
  let raw = Buffer.from(d.body_utf8, "utf8");
  let signature = d.headers["x-signature"];
  let timestamp = d.headers["x-timestamp"];
  if (flag("--tamper")) {
    raw = Buffer.from(raw);
    raw[raw.length - 2] ^= 1;
  }
  if (flag("--stale")) {
    timestamp = String(receivedAtMs - 10 * 60 * 1000);
    signature = sign(timestamp, raw);
  }
  const r = verify({ raw, receivedAtMs, signature, timestamp });
  console.log(
    `${r.ok ? "VALID  " : "INVALID"} sig=${r.sigOk} fresh=${r.fresh} age_ms=${r.ageMs} ${f}`,
  );
  r.ok ? okCount++ : badCount++;
}
console.log(`files=${files.length} valid=${okCount} invalid=${badCount}`);
if (flag("--expect-valid") && badCount) process.exit(1);
if (flag("--expect-invalid") && okCount) process.exit(1);
if (!files.length) process.exit(1);
