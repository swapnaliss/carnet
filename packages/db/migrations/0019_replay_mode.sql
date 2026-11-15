-- M4-05: judge replay mode, demo reset and per-session caps (ADR 0018 amendment 2).
-- 1. The session's mode is a server-side attribute of the better-auth session row. The judge (role
--    `viewer`) is always in replay whatever this column says; only the owner may set `live`.
ALTER TABLE "auth_sessions" ADD COLUMN "mode" text DEFAULT 'live' NOT NULL;
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_mode_check" CHECK ("mode" IN ('live', 'replay'));
--> statement-breakpoint
-- 2. The web session that queued a model run, so SESSION_MODEL_CAP_USD can be summed per session.
--    No foreign key: a session row is deleted on sign-out, its spend stays counted against nobody.
ALTER TABLE "agent_runs" ADD COLUMN "session_id" uuid;
--> statement-breakpoint
CREATE INDEX "agent_runs_session_id_idx" ON "agent_runs" ("session_id") WHERE "session_id" IS NOT NULL;
--> statement-breakpoint
-- 3. The demo-database marker. `npm run demo:reset` refuses a database without this row. Every Carnet
--    database holds synthetic data only (CLAUDE.md data policy), so the migration sets it; removing the
--    row (migration role) protects a database from the reset. The app role may only read it.
CREATE TABLE "demo_database" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"purpose" text NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_database_singleton_check" CHECK ("id")
);
--> statement-breakpoint
INSERT INTO "demo_database" ("id", "purpose") VALUES (true, 'synthetic demo data only (CLAUDE.md data policy)') ON CONFLICT DO NOTHING;
--> statement-breakpoint
REVOKE ALL ON TABLE "demo_database" FROM carnet_app;
--> statement-breakpoint
GRANT SELECT ON TABLE "demo_database" TO carnet_app;
--> statement-breakpoint
-- 4. The replay recording index: one row per recording loaded by the demo reset (manifest, the ordered
--    timeline built from the recording's files, and the ids its screens resolve to in the replay business).
CREATE TABLE "replay_recordings" (
	"id" text PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"timeline" jsonb NOT NULL,
	"refs" jsonb NOT NULL,
	"materialized" boolean NOT NULL,
	"loaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "replay_recordings_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id")
);
