import { call, getToken, record, requireEnv } from "./lib.mjs";

requireEnv();

export async function run() {
  await getToken();
  // burst above the documented 10 per endpoint per second
  const N = Number(process.env.BURST ?? 150);
  const started = Date.now();
  const rs = await Promise.all(
    Array.from({ length: N }, (_, i) => call(`tmp-burst-${i}`, "GET", "/api/v1/balances/current")),
  );
  const counts = {};
  for (const r of rs) counts[r.status] = (counts[r.status] ?? 0) + 1;
  const limited = rs.find((r) => r.status === 429);
  const hdrs = new Set(rs.flatMap((r) => Object.keys(r.headers)));
  record("rate-limit-burst", {
    endpoint: "GET /api/v1/balances/current",
    requests: N,
    windowMs: Date.now() - started,
    statusCounts: counts,
    firstLimited: limited
      ? { status: limited.status, headers: limited.headers, body: limited.body }
      : null,
    responseHeadersSeen: [...hdrs],
  });
  // error body shape on a not-found and on a malformed id
  await call(
    "error-transfer-not-found",
    "GET",
    "/api/v1/transfers/00000000-0000-0000-0000-000000000000",
  );
  await call("error-bad-json-field", "POST", "/api/v1/transfers/create", {
    body: { request_id: "x" },
  });
  // recover after the burst
  await new Promise((r) => setTimeout(r, 1500));
  const ok = await call("rate-limit-recovered", "GET", "/api/v1/balances/current");
  return { counts, recovered: ok.status };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(await run());
