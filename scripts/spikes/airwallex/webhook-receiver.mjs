// Throwaway M0-05 receiver (not the production route; that is M1-05). No dependencies.
// Logs one `WEBHOOK {json}` line per request to stdout with the raw headers and the raw body (base64 and utf8), so
// deliveries can be read back from the host's logs. If AIRWALLEX_WEBHOOK_SECRET is set it also checks the HMAC
// over `x-timestamp + rawBody`; the secret is never printed. Offline verification is verify-hmac.mjs.
// FAIL_ONCE_NAMES=a,b (default below, because the host's env cannot be changed from the CLI): the first delivery of each event name listed gets HTTP 500 (forces a redelivery).
import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
const secret = process.env.AIRWALLEX_WEBHOOK_SECRET ?? "";
const failOnce = new Set(
  (process.env.FAIL_ONCE_NAMES ?? "payout.transfer.paid,rfi.closed").split(",").filter(Boolean),
);
const failed = new Set();

function check(headers, raw) {
  if (!secret) return "no-secret-on-server";
  const ts = String(headers["x-timestamp"] ?? "");
  const sig = String(headers["x-signature"] ?? "");
  const want = createHmac("sha256", secret).update(ts).update(raw).digest("hex");
  const a = Buffer.from(want);
  const b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b) ? "valid" : "invalid";
}

createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"status":"ok","mode":"webhook-spike"}');
      return;
    }
    const raw = Buffer.concat(chunks);
    let name = null;
    let id = null;
    try {
      const j = JSON.parse(raw.toString("utf8"));
      name = j.name ?? null;
      id = j.id ?? null;
    } catch {}
    const key = `${name}`;
    const forceFail = name && failOnce.has(name) && !failed.has(key);
    if (forceFail) failed.add(key);
    const status = forceFail ? 500 : 200;
    console.log(
      `WEBHOOK ${JSON.stringify({
        received_at: new Date().toISOString(),
        method: req.method,
        path: req.url,
        status_returned: status,
        hmac: check(req.headers, raw),
        headers: req.headers,
        body_utf8: raw.toString("utf8"),
        body_base64: raw.toString("base64"),
        event_name: name,
        event_id: id,
      })}`,
    );
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? '{"ok":true}' : '{"ok":false}');
  });
}).listen(port, "0.0.0.0", () => console.log(`webhook-spike listening on ${port}`));
