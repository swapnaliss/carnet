import { call, env, invalidateToken, requireEnv, setTokenForTest } from "./lib.mjs";

requireEnv();

export async function run() {
  // login: capture shape (token redacted by the recorder)
  const login = await call("auth-login", "POST", "/api/v1/authentication/login", {
    auth: false,
    headers: { "x-client-id": env.clientId, "x-api-key": env.apiKey },
  });
  if (login.status !== 201 && login.status !== 200) throw new Error(`login ${login.status}`);
  // bad credentials
  await call("auth-login-bad-key", "POST", "/api/v1/authentication/login", {
    auth: false,
    headers: { "x-client-id": env.clientId, "x-api-key": "not-a-real-key-0000" },
  });
  // invalid token on an authenticated endpoint
  setTokenForTest("invalid.token.value");
  await call("auth-invalid-token", "GET", "/api/v1/balances/current");
  invalidateToken();
}
if (import.meta.url === `file://${process.argv[1]}`) await run();
