import { boolean, check, index, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { createdAt, oneOf, tstz } from "./columns";

export const USER_ROLES = ["owner", "approver", "viewer"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// The better-auth `user` model (M1-04) maps onto this table: `email_verified`, `image` and
// `updated_at` are its columns; `business_id` and `role` are its additional fields. Credentials and
// sessions live in the auth_* tables (schema/auth.ts).
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
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: tstz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    index("users_business_id_idx").on(t.businessId),
    check("users_role_check", oneOf("role", USER_ROLES)),
  ],
);
