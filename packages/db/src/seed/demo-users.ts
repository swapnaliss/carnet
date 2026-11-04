// Demo users (M1-04, ADR 0012): one demo business with an owner, an approver and a read-only judge
// (role `viewer`). There is no public sign-up, so these rows are how users exist. Passwords come
// only from the environment; a missing or short one aborts the seed (there is no default password),
// in every environment. Idempotent: fixed ids, upserts, and the password hash is rewritten so a
// rotated key takes effect on the next run. M1-06 `scripts/setup.ts` calls `seedDemoUsers(db)`.
import type { BusinessId, UserId } from "@carnet/domain";
import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { type Db, withTransaction } from "../client";
import { authAccounts, businesses, type UserRole, users } from "../schema/index";

export const DEMO_BUSINESS_ID = "b1a61635-d7fe-43e3-ad8e-97a7016ef11c" as BusinessId;
export const DEMO_BUSINESS_NAME = "Northwind Studio (demo)";

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

function passwordsFrom(env: Record<string, string | undefined>): Map<SeedPasswordEnvKey, string> {
  const bad = SEED_PASSWORD_ENV_KEYS.filter(
    (k) => (env[k] ?? "").length < SEED_PASSWORD_MIN_LENGTH,
  );
  if (bad.length > 0) throw new SeedConfigError(bad);
  return new Map(SEED_PASSWORD_ENV_KEYS.map((k) => [k, env[k] as string]));
}

export async function seedDemoUsers(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<SeedResult> {
  const passwords = passwordsFrom(env);
  // Hash before the transaction: scrypt is slow and must not hold a connection open.
  const hashes = new Map<UserId, string>();
  for (const u of DEMO_USERS) {
    hashes.set(u.id, await hashPassword(passwords.get(u.passwordKey) as string));
  }

  return withTransaction(db, async (tx) => {
    await tx
      .insert(businesses)
      .values({ id: DEMO_BUSINESS_ID, name: DEMO_BUSINESS_NAME })
      .onConflictDoNothing({ target: businesses.id });

    const seeded: SeededUser[] = [];
    for (const u of DEMO_USERS) {
      const [row] = await tx
        .insert(users)
        .values({
          id: u.id,
          businessId: DEMO_BUSINESS_ID,
          email: u.email,
          name: u.name,
          role: u.role,
          emailVerified: true,
        })
        .onConflictDoUpdate({
          target: users.email,
          set: { name: u.name, role: u.role, updatedAt: sql`now()` },
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
    return { businessId: DEMO_BUSINESS_ID, users: seeded };
  });
}
