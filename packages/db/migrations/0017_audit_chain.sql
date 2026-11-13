CREATE TABLE "audit_chain_head" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"last_id" bigint,
	"last_hash" text,
	"row_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_chain_head_singleton_check" CHECK ("audit_chain_head"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "audit_chain_status" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"ok" boolean NOT NULL,
	"checked" integer NOT NULL,
	"first_bad_id" bigint,
	"reason" text,
	"head_hash" text,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_chain_status_singleton_check" CHECK ("audit_chain_status"."id" = 1)
);
--> statement-breakpoint
-- M4-01 / ADR 0013. Custom part, run by the migration role (the owner), idempotent.
-- 1. The chain head: one row, seeded empty. Rows written before this migration carry no hash
--    ("legacy"); the chain starts at the first hashed row (verifyAuditChain).
INSERT INTO audit_chain_head (id, last_id, last_hash, row_count) VALUES (1, NULL, NULL, 0)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
-- 2. The app role appends rows (INSERT/SELECT on audit_log only, migration 0001), advances the head
--    and stores the verification result; it never deletes either.
REVOKE ALL ON TABLE audit_chain_head, audit_chain_status FROM carnet_app;
--> statement-breakpoint
GRANT SELECT, UPDATE ON TABLE audit_chain_head TO carnet_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE audit_chain_status TO carnet_app;
--> statement-breakpoint
-- 3. Defence in depth: refuse UPDATE, DELETE and TRUNCATE on audit_log even for roles that hold the
--    privilege. The owner can remove a trigger, which is why the role grants (not this trigger) are
--    the control the tests prove, and why the chain detects what the owner does anyway.
CREATE OR REPLACE FUNCTION audit_log_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% not allowed)', TG_OP USING ERRCODE = '42501';
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_update_delete ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();
--> statement-breakpoint
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
