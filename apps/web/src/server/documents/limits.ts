// Upload limits (M2-01), read from the environment on each call so a test or a deploy can change
// them without a rebuild. Documented in .env.example.
//   UPLOAD_MAX_BYTES          the upload request body (file + multipart framing), default 5 MiB;
//                             never above MAX_BODY_BYTES (5 MiB)
//   UPLOAD_SESSION_MAX_FILES  uploads per session per hour, default 10 (every attempt counts)
//   UPLOAD_SESSION_MAX_BYTES  bytes stored per session per hour, default 25 MiB
import {
  DEFAULT_UPLOAD_MAX_BYTES,
  DEFAULT_UPLOAD_SESSION_MAX_BYTES,
  DEFAULT_UPLOAD_SESSION_MAX_FILES,
} from "@carnet/domain";
import { MAX_BODY_BYTES } from "../../lib/define-route";

export const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

export interface UploadLimits {
  /** The upload request body cap (UPLOAD_MAX_BYTES): the file plus its multipart framing. */
  readonly maxBytes: number;
  readonly sessionMaxFiles: number;
  readonly sessionMaxBytes: number;
  readonly windowMs: number;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export function uploadLimits(env: Record<string, string | undefined> = process.env): UploadLimits {
  return {
    maxBytes: Math.min(positiveInt(env.UPLOAD_MAX_BYTES, DEFAULT_UPLOAD_MAX_BYTES), MAX_BODY_BYTES),
    sessionMaxFiles: positiveInt(env.UPLOAD_SESSION_MAX_FILES, DEFAULT_UPLOAD_SESSION_MAX_FILES),
    sessionMaxBytes: positiveInt(env.UPLOAD_SESSION_MAX_BYTES, DEFAULT_UPLOAD_SESSION_MAX_BYTES),
    windowMs: UPLOAD_WINDOW_MS,
  };
}
