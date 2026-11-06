// Shared setup for the documents tests (M2-01): the same route specs as the app, declared on a test
// kit with a real per-worker database and real sessions.
import { readFileSync } from "node:fs";
import { createRouteKit, type RouteHandler } from "../../src/lib/define-route";
import type { UploadLimits } from "../../src/server/documents/limits";
import { documentRouteSpecs } from "../../src/server/documents/routes";
import { type AuthTestEnv, ORIGIN } from "../auth/setup";

export const dataset = (name: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(
    readFileSync(new URL(`../../../../fixtures/dataset/${name}`, import.meta.url)),
  ) as Uint8Array<ArrayBuffer>;

export const DEFAULT_TEST_LIMITS: UploadLimits = {
  maxBytes: 5 * 1024 * 1024,
  sessionMaxFiles: 10,
  sessionMaxBytes: 25 * 1024 * 1024,
  windowMs: 3_600_000,
};

export interface DocumentRoutesUnderTest {
  readonly upload: RouteHandler;
  readonly download: RouteHandler;
  readonly meta: RouteHandler;
}

/** A fresh kit (a "process restart": no in-memory state; counters live in the database). */
export function documentRoutes(
  env: AuthTestEnv,
  options: { limits?: UploadLimits; now?: () => Date } = {},
): DocumentRoutesUnderTest {
  const kit = createRouteKit({
    authz: env.authz,
    db: () => env.db,
    logger: () => env.rt.logger,
    now: options.now ?? (() => new Date()),
  });
  const specs = documentRouteSpecs({
    limits: () => options.limits ?? DEFAULT_TEST_LIMITS,
    ...(options.now ? { now: options.now } : {}),
    logger: () => env.rt.logger,
  });
  return {
    upload: kit.defineRoute(specs.upload),
    download: kit.defineRoute(specs.download),
    meta: kit.defineRoute(specs.meta),
  };
}

export function uploadRequest(
  cookie: string,
  file: { bytes: Uint8Array<ArrayBuffer>; name: string; type?: string } | null,
  fields: Record<string, string> = {},
): Request {
  const form = new FormData();
  if (file) form.append("file", new Blob([file.bytes], { type: file.type ?? "" }), file.name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return new Request(`${ORIGIN}/api/v1/documents`, {
    method: "POST",
    headers: { cookie, origin: ORIGIN },
    body: form,
  });
}

export function getRequest(path: string, cookie: string): Request {
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers: { cookie, origin: ORIGIN } });
}

export const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
