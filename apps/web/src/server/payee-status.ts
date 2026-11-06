// Payee status links (M3-06): token handling and the public lookup. Controls from the STRIDE row for
// information disclosure (docs/architecture.md §8):
// - the token is 256 bits from the platform CSPRNG (43 base64url characters); only its SHA-256 is
//   stored, and a log line carries at most the first 6 hash characters
// - unknown, expired and revoked tokens end in the same outcome (`not_found`), after the same work:
//   hash, one indexed lookup, one constant-time comparison; nothing is written for an unknown token
// - the per-IP counter runs first, for every request, so guessing is bounded before any lookup; the
//   per-token counter (token-hash prefix) runs only for a live link, so a flood of random tokens
//   cannot create counter rows per guess
// - GENERIC hides a hold; the words come from the pure mapping in @carnet/domain
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type Db,
  findPayeeLinkByTokenHash,
  type PayeeLinkTarget,
  touchPayeeLinkViewed,
} from "@carnet/db";
import { type PayeeStatus, payeeStatus } from "@carnet/domain";
import { consumeRateLimit, type RateLimitRule, rateLimitKey } from "../lib/ratelimit";

export const PAYEE_TOKEN_BYTES = 32;
/** 32 bytes in base64url, unpadded. */
export const PAYEE_TOKEN_LENGTH = 43;
export const DEFAULT_PAYEE_LINK_TTL_HOURS = 72;
export const MAX_PAYEE_LINK_TTL_HOURS = 30 * 24;
export const DEFAULT_PAYEE_STATUS_RATE_LIMIT_PER_MIN = 30;
/** Tokens longer than this are cut before hashing, so a hostile path cannot make hashing costly. */
const MAX_TOKEN_INPUT = 256;
const TOKEN_HASH_PREFIX_FOR_LIMIT = 16;
const NO_HASH = "0".repeat(64);

type Env = Record<string, string | undefined>;

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** A fresh token: 256 bits from the CSPRNG, base64url. Shown once; never stored. */
export function newPayeeToken(): string {
  return randomBytes(PAYEE_TOKEN_BYTES).toString("base64url");
}

/** SHA-256 of the token, 64 lower-case hex characters: the only form that is stored. */
export function hashPayeeToken(token: string): string {
  return createHash("sha256").update(token.slice(0, MAX_TOKEN_INPUT)).digest("hex");
}

/** `PAYEE_LINK_TTL_HOURS` (default 72), never more than 30 days. */
export function defaultPayeeLinkTtlHours(env: Env = process.env): number {
  return Math.min(
    positiveInt(env.PAYEE_LINK_TTL_HOURS, DEFAULT_PAYEE_LINK_TTL_HOURS),
    MAX_PAYEE_LINK_TTL_HOURS,
  );
}

/** `PAYEE_STATUS_RATE_LIMIT_PER_MIN` (default 30) per minute. */
export function payeeStatusRateLimit(env: Env = process.env): RateLimitRule {
  return {
    limit: positiveInt(
      env.PAYEE_STATUS_RATE_LIMIT_PER_MIN,
      DEFAULT_PAYEE_STATUS_RATE_LIMIT_PER_MIN,
    ),
    windowMs: 60_000,
  };
}

/** Whether an open Airwallex RFI is holding this payment. */
export type OpenRfiLookup = (db: Db, paymentId: string) => Promise<boolean>;

/**
 * No `rfis` table exists until M2-04, so no RFI can be open yet. M2-04 replaces this with a query on
 * `rfis` (open = not ANSWERED/CLOSED/EXPIRED) and the route picks it up unchanged (BL-01).
 */
export const noOpenRfi: OpenRfiLookup = async () => false;

export interface PayeeStatusDeps {
  readonly db: Db;
  readonly now: () => Date;
  readonly openRfi: OpenRfiLookup;
  readonly env?: Env;
}

export type PayeeStatusOutcome =
  | {
      readonly kind: "ok";
      readonly status: PayeeStatus;
      readonly updatedAt: Date;
      /** First 6 hash characters: the only token-derived value that may be logged. */
      readonly tokenHashPrefix: string;
    }
  | { readonly kind: "not_found"; readonly tokenHashPrefix: string }
  | { readonly kind: "limited"; readonly retryAfter: number };

function sameHash(stored: string | undefined, given: string): boolean {
  const a = Buffer.from(stored ?? NO_HASH, "utf8");
  const b = Buffer.from(given, "utf8");
  return a.length === b.length && timingSafeEqual(a, b) && stored !== undefined;
}

function isLive(link: PayeeLinkTarget, now: Date): boolean {
  return link.revokedAt === null && link.expiresAt.getTime() > now.getTime();
}

export async function lookupPayeeStatus(
  deps: PayeeStatusDeps,
  token: string,
  ip: string,
): Promise<PayeeStatusOutcome> {
  const now = deps.now();
  const rule = payeeStatusRateLimit(deps.env);

  const byIp = await consumeRateLimit(deps.db, rateLimitKey("payee_status", "ip", ip), rule, now);
  if (!byIp.allowed) return { kind: "limited", retryAfter: byIp.retryAfter };

  const hash = hashPayeeToken(token);
  const tokenHashPrefix = hash.slice(0, 6);
  const link = await findPayeeLinkByTokenHash(deps.db, hash);
  const matches = sameHash(link?.tokenHash, hash);
  if (!link || !matches || !isLive(link, now)) return { kind: "not_found", tokenHashPrefix };

  const byToken = await consumeRateLimit(
    deps.db,
    rateLimitKey("payee_status", "token", hash.slice(0, TOKEN_HASH_PREFIX_FOR_LIMIT)),
    rule,
    now,
  );
  if (!byToken.allowed) return { kind: "limited", retryAfter: byToken.retryAfter };

  const openRfi = await deps.openRfi(deps.db, link.paymentId);
  await touchPayeeLinkViewed(deps.db, link.linkId, now);
  return {
    kind: "ok",
    status: payeeStatus(link.transferStatus, openRfi, link.disclosureLevel),
    updatedAt: link.updatedAt,
    tokenHashPrefix,
  };
}
