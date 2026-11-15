// Demo users (M1-04, ADR 0012): one demo business with an owner, an approver and a read-only judge
// (role `viewer`). There is no public sign-up, so these rows are how users exist. Passwords come
// only from the environment; a missing or short one aborts the seed (there is no default password),
// in every environment. Idempotent: fixed ids, upserts, and the password hash is rewritten so a
// rotated key takes effect on the next run. M1-06 `scripts/setup.ts` calls
// `seedDemoUsers(db, { businessId: DEMO_BUSINESS_ID })` after `ensureDemoBusiness`, so the users join
// that business; without `businessId` the seed creates (or reuses) its own default business.
import type { BusinessId, UserId } from "@carnet/domain";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { type Db, withTransaction } from "../client";
import { authAccounts, businesses, type UserRole, users } from "../schema/index";

/** The business used when the caller passes none (named apart from M1-06's DEMO_BUSINESS_ID). */
export const SEED_DEFAULT_BUSINESS_ID = "b1a61635-d7fe-43e3-ad8e-97a7016ef11c" as BusinessId;
export const SEED_DEFAULT_BUSINESS_NAME = "Northwind Studio (demo)";

export const SEED_PASSWORD_ENV_KEYS = [
  "SEED_OWNER_PASSWORD",
  "SEED_APPROVER_PASSWORD",
  "SEED_JUDGE_PASSWORD",
] as const;
export type SeedPasswordEnvKey = (typeof SEED_PASSWORD_ENV_KEYS)[number];

/** better-auth's default minimum password length. */
export const SEED_PASSWORD_MIN_LENGTH = 8;

export interface DemoUser {
  readonly id: UserId;
  readonly email: string;
  readonly name: string;
  readonly role: UserRole;
  readonly passwordKey: SeedPasswordEnvKey;
}

/** The judge is labelled read-only in its name; its role `viewer` is what enforces it. */
export const DEMO_USERS: readonly DemoUser[] = [
  {
    id: "3a3267da-129d-4e29-85ae-829cdf075842" as UserId,
    email: "owner@carnet.example",
    name: "Demo owner",
    role: "owner",
    passwordKey: "SEED_OWNER_PASSWORD",
  },
  {
    id: "ccd97ec5-8726-4730-8fcb-f3a9dea56f6a" as UserId,
    email: "approver@carnet.example",
    name: "Demo approver",
    role: "approver",
    passwordKey: "SEED_APPROVER_PASSWORD",
  },
  {
    id: "3620553f-1d7b-4bbb-9f50-6bb3cd30368a" as UserId,
    email: "judge@carnet.example",
    name: "Judge (read-only replay)",
    role: "viewer",
    passwordKey: "SEED_JUDGE_PASSWORD",
  },
];

/** A required seed password is missing or too short. The message names keys, never values. */
export class SeedConfigError extends Error {
  readonly keys: readonly SeedPasswordEnvKey[];
  constructor(keys: readonly SeedPasswordEnvKey[]) {
    super(
      `seed aborted: set ${keys.join(", ")} (at least ${SEED_PASSWORD_MIN_LENGTH} characters each); there are no default passwords`,
    );
    this.name = "SeedConfigError";
    this.keys = keys;
  }
}

export interface SeededUser {
  readonly id: UserId;
  readonly email: string;
  readonly role: UserRole;
}

export interface SeedResult {
  readonly businessId: BusinessId;
  readonly users: readonly SeededUser[];
}

function passwordsFrom(
  env: Record<string, string | undefined>,
  optional: readonly SeedPasswordEnvKey[] = [],
): Map<SeedPasswordEnvKey, string> {
  const ok = (k: SeedPasswordEnvKey) => (env[k] ?? "").length >= SEED_PASSWORD_MIN_LENGTH;
  const bad = SEED_PASSWORD_ENV_KEYS.filter((k) => !ok(k) && !optional.includes(k));
  if (bad.length > 0) throw new SeedConfigError(bad);
  return new Map(SEED_PASSWORD_ENV_KEYS.filter(ok).map((k) => [k, env[k] as string]));
}

export interface SeedDemoUsersOptions {
  /** Where the passwords come from (default `process.env`). */
  env?: Record<string, string | undefined>;
  /**
   * The business the users join. It is created with `businessName` only if no row has this id, so an
   * existing business (M1-06 `ensureDemoBusiness`) is left as it is. Default SEED_DEFAULT_BUSINESS_ID.
   */
  businessId?: BusinessId;
  businessName?: string;
  /**
   * M4-05 (demo reset): keys that may be absent; a user whose key is absent is left as it is (not
   * created, its password not rewritten). Default none: every key is required.
   */
  optionalKeys?: readonly SeedPasswordEnvKey[];
}

export async function seedDemoUsers(
  db: Db,
  options: SeedDemoUsersOptions = {},
): Promise<SeedResult> {
  const passwords = passwordsFrom(options.env ?? process.env, options.optionalKeys);
  const businessId = options.businessId ?? SEED_DEFAULT_BUSINESS_ID;
  const selected = DEMO_USERS.filter((u) => passwords.has(u.passwordKey));
  // Hash before the transaction: scrypt is slow and must not hold a connection open.
  const hashes = new Map<UserId, string>();
  for (const u of selected) {
    hashes.set(u.id, await hashPassword(passwords.get(u.passwordKey) as string));
  }

  return withTransaction(db, async (tx) => {
    await tx
      .insert(businesses)
      .values({ id: businessId, name: options.businessName ?? SEED_DEFAULT_BUSINESS_NAME })
      .onConflictDoNothing({ target: businesses.id });

    const seeded: SeededUser[] = [];
    for (const u of selected) {
      const [row] = await tx
        .insert(users)
        .values({
          id: u.id,
          businessId,
          email: u.email,
          name: u.name,
          role: u.role,
          emailVerified: true,
        })
        .onConflictDoUpdate({
          target: users.email,
          // The seed decides where the demo users belong: a re-run with another businessId moves them.
          set: { businessId, name: u.name, role: u.role, updatedAt: sql`now()` },
        })
        .returning({ id: users.id });
      if (!row) throw new Error("user upsert returned no row");
      const userId = row.id as UserId;
      await tx
        .insert(authAccounts)
        .values({
          userId,
          accountId: userId,
          providerId: "credential",
          password: hashes.get(u.id) as string,
        })
        .onConflictDoUpdate({
          target: [authAccounts.providerId, authAccounts.accountId],
          set: { password: hashes.get(u.id) as string, updatedAt: sql`now()` },
        });
      seeded.push({ id: userId, email: u.email, role: u.role });
    }
    return { businessId, users: seeded };
  });
}
