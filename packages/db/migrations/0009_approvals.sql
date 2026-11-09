CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_ref" text NOT NULL,
	"hash" text NOT NULL,
	"nonce" text NOT NULL,
	"approver_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"end_reason" text,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"shown_snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "approvals_kind_check" CHECK ("kind" IN ('rfi_answer')),
	CONSTRAINT "approvals_status_check" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED', 'CONSUMED')),
	CONSTRAINT "approvals_end_reason_check" CHECK ("end_reason" IN ('REJECTED_BY_USER', 'SUPERSEDED', 'TTL', 'KILL_SWITCH', 'RFI_CHANGED')),
	CONSTRAINT "approvals_hash_check" CHECK ("approvals"."hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "approvals_consumed_check" CHECK (("status" = 'CONSUMED') = ("consumed_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_approver_id_users_id_fk" FOREIGN KEY ("approver_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approvals_business_id_subject_ref_idx" ON "approvals" USING btree ("business_id","kind","subject_ref");--> statement-breakpoint
CREATE INDEX "approvals_status_expires_at_idx" ON "approvals" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_nonce_key" ON "approvals" USING btree ("nonce");--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_one_live_per_subject" ON "approvals" USING btree ("business_id","kind","subject_ref") WHERE "status" IN ('PENDING', 'APPROVED');--> statement-breakpoint
-- M2-07 (ADR 0008): an approval is bound to the content it was granted for. Only the status columns
-- (status, end_reason, consumed_at, updated_at) may change; a trigger refuses a change to anything the
-- hash covers or the approver saw, for every role (the app role included).
CREATE FUNCTION approvals_refuse_binding_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.subject_ref IS DISTINCT FROM OLD.subject_ref
     OR NEW.hash IS DISTINCT FROM OLD.hash
     OR NEW.nonce IS DISTINCT FROM OLD.nonce
     OR NEW.approver_id IS DISTINCT FROM OLD.approver_id
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.shown_snapshot IS DISTINCT FROM OLD.shown_snapshot THEN
    RAISE EXCEPTION 'approvals: the bound content of an approval cannot change' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER approvals_immutable_binding BEFORE UPDATE ON "approvals"
  FOR EACH ROW EXECUTE FUNCTION approvals_refuse_binding_change();