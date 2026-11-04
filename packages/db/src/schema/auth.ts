// better-auth 1.7.15 credential, session and verification tables (ADR 0012, M1-04). The `user`
// model is `users` (schema/users.ts). Field names are better-auth's; the auth config in
// apps/web/src/lib/auth.ts maps its models onto these tables. Ids are UUIDs like every other table.
import { index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, tstz } from "./columns";
import { users } from "./users";

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_key").on(t.token),
    index("auth_sessions_user_id_idx").on(t.userId),
  ],
);

/** One row per sign-in method; the email-and-password row has provider_id `credential`. */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    /** better-auth's scrypt hash (`salt:key`), never the password. */
    password: text("password"),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: tstz("access_token_expires_at"),
    refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
    scope: text("scope"),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("auth_accounts_provider_account_key").on(t.providerId, t.accountId),
    index("auth_accounts_user_id_idx").on(t.userId),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tstz("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);
