// M4-05 (ADR 0018 amendment 2): the demo-database marker and the replay recording index.
import { boolean, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { businesses } from "./businesses";
import { tstz } from "./columns";

/** One row when this database may be reset by `npm run demo:reset` (set by migration 0019). */
export const demoDatabase = pgTable("demo_database", {
  id: boolean("id").primaryKey().default(true),
  purpose: text("purpose").notNull(),
  markedAt: tstz("marked_at").notNull().defaultNow(),
});

/** A recording loaded into the replay business by the demo reset. */
export const replayRecordings = pgTable("replay_recordings", {
  id: text("id").primaryKey(),
  businessId: uuid("business_id")
    .notNull()
    .references(() => businesses.id),
  position: integer("position").notNull(),
  manifest: jsonb("manifest").$type<unknown>().notNull(),
  timeline: jsonb("timeline").$type<unknown>().notNull(),
  refs: jsonb("refs").$type<Record<string, string>>().notNull(),
  materialized: boolean("materialized").notNull(),
  loadedAt: tstz("loaded_at").notNull().defaultNow(),
});
