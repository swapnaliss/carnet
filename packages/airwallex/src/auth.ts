// Bearer token cache: login with x-client-id / x-api-key, keep the token in memory, refresh at
// 25 minutes (lifetime 30, fixture `auth-login`), one login in flight at a time, and exactly one forced
// re-login when a call answers 401. The key and the token are held in private fields and never logged.
import { z } from "zod";
import { AirwallexApiError, type HttpClient, type RequestOptions } from "./http";

export const LOGIN_PATH = "/api/v1/authentication/login";
export const TOKEN_REFRESH_MS = 25 * 60 * 1000;

const LoginResponse = z.object({ token: z.string().min(1), expires_at: z.string() });

export interface Credentials {
  clientId: string;
  apiKey: string;
}

export class TokenCache {
  readonly #http: HttpClient;
  readonly #clientId: string;
  readonly #apiKey: string;
  readonly #now: () => number;
  #token: string | undefined;
  #obtainedAt = 0;
  #inflight: Promise<string> | undefined;
  /** Number of logins performed (observable for tests and metrics; never the token). */
  logins = 0;

  constructor(http: HttpClient, creds: Credentials, now: () => number = Date.now) {
    this.#http = http;
    this.#clientId = creds.clientId;
    this.#apiKey = creds.apiKey;
    this.#now = now;
  }

  async token(): Promise<string> {
    if (this.#token && this.#now() - this.#obtainedAt < TOKEN_REFRESH_MS) return this.#token;
    this.#inflight ??= this.#login().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  /** Drops `stale` if it is still the cached token, so the next `token()` logs in again. */
  invalidate(stale: string): void {
    if (this.#token === stale) this.#token = undefined;
  }

  async #login(): Promise<string> {
    this.logins += 1;
    try {
      const res = await this.#http.request({
        method: "POST",
        path: LOGIN_PATH,
        headers: { "x-client-id": this.#clientId, "x-api-key": this.#apiKey },
        schema: LoginResponse,
        retryable: true, // login has no side effect
      });
      this.#token = res.token;
      this.#obtainedAt = this.#now();
      this.#http.logger.info({ expiresAt: res.expires_at }, "airwallex login ok");
      return res.token;
    } catch (err) {
      const fields: Record<string, unknown> = { path: LOGIN_PATH };
      if (err instanceof AirwallexApiError) {
        fields.status = err.status;
        fields.code = err.code;
      } else if (err instanceof Error) {
        fields.error = err.name;
      }
      this.#http.logger.error(fields, "airwallex login failed");
      throw err;
    }
  }

  toJSON(): Record<string, unknown> {
    return { cached: this.#token !== undefined, logins: this.logins };
  }
}

/** Runs an authenticated request; on 401 logs in again exactly once and repeats the call. */
export async function authed<T>(
  http: HttpClient,
  tokens: TokenCache,
  opts: Omit<RequestOptions<T>, "bearer">,
): Promise<T> {
  const token = await tokens.token();
  try {
    return await http.request({ ...opts, bearer: token });
  } catch (err) {
    if (!(err instanceof AirwallexApiError) || err.status !== 401) throw err;
    tokens.invalidate(token);
    http.logger.warn({ method: opts.method, path: opts.path }, "airwallex 401, logging in again");
    const fresh = await tokens.token();
    return http.request({ ...opts, bearer: fresh });
  }
}
