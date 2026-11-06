CREATE TABLE "plan_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"reason_code" text NOT NULL,
	"params" jsonb NOT NULL,
	"reason_facts" jsonb NOT NULL,
	"needs_approval" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_actions_plan_id_seq_key" UNIQUE("plan_id","seq"),
	CONSTRAINT "plan_actions_kind_check" CHECK ("kind" IN ('fund', 'convert', 'defer', 'escalate', 'payout')),
	CONSTRAINT "plan_actions_seq_check" CHECK ("seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"inputs_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_hash" text NOT NULL,
	"held_funds_visible_in_balances" boolean NOT NULL,
	"planned_at" timestamp with time zone NOT NULL,
	"trigger" text,
	"inputs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plans_business_id_revision_key" UNIQUE("business_id","revision"),
	CONSTRAINT "plans_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "plans_revision_check" CHECK ("revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "plan_actions" ADD CONSTRAINT "plan_actions_plan_same_business_fk" FOREIGN KEY ("plan_id","business_id") REFERENCES "public"."plans"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_actions_business_id_idx" ON "plan_actions" USING btree ("business_id");--> statement-breakpoint
-- Append-only (M3-02): the default privileges of 0001_grants.sql gave the app role DML on the new
-- tables; a stored plan revision is never changed, so take UPDATE and DELETE back (as audit_log does).
REVOKE UPDATE, DELETE ON TABLE plans FROM carnet_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE plan_actions FROM carnet_app;
