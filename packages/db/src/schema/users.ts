import { check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf } from "./columns";

export const USER_ROLES = ["owner", "approver", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Domain columns only; credential and session tables come from better-auth (M1-04).
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    businessId: uuid("business_id")
      .notNull()
      .references(() => businesses.id),
    email: text("email").notNull(),
    name: text("name"),
    role: text("role").$type<UserRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    index("users_business_id_idx").on(t.businessId),
    check("users_role_check", oneOf("role", USER_ROLES)),
  ],
);
