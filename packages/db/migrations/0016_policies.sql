CREATE TABLE "auto_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"policy_version" integer NOT NULL,
	"policy_hash" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"daily_total_after_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auto_approvals_action_id_key" UNIQUE("action_id"),
	CONSTRAINT "auto_approvals_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "auto_approvals_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "fx_quote_uses" (
	"quote_id" text PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plan_action_states" (
	"action_id" uuid PRIMARY KEY NOT NULL,
	"business_id" uuid NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"reason" text,
	"attempt_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_action_states_status_check" CHECK ("status" IN ('PROPOSED', 'APPROVED', 'AUTO_APPROVED', 'EXECUTING', 'DONE', 'FAILED', 'SUPERSEDED'))
);
--> statement-breakpoint
CREATE TABLE "policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policies_business_id_version_key" UNIQUE("business_id","version"),
	CONSTRAINT "policies_business_id_version_hash_key" UNIQUE("business_id","version","hash"),
	CONSTRAINT "policies_version_check" CHECK ("version" > 0),
	CONSTRAINT "policies_hash_check" CHECK ("policies"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "approvals" DROP CONSTRAINT "approvals_kind_check";--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fee_option" text DEFAULT 'DEFAULT' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "value_date" date;--> statement-breakpoint
ALTER TABLE "auto_approvals" ADD CONSTRAINT "auto_approvals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_approvals" ADD CONSTRAINT "auto_approvals_action_id_plan_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."plan_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auto_approvals" ADD CONSTRAINT "auto_approvals_policy_fk" FOREIGN KEY ("business_id","policy_version","policy_hash") REFERENCES "public"."policies"("business_id","version","hash") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_quote_uses" ADD CONSTRAINT "fx_quote_uses_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fx_quote_uses" ADD CONSTRAINT "fx_quote_uses_action_id_plan_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."plan_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_action_states" ADD CONSTRAINT "plan_action_states_action_id_plan_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."plan_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_action_states" ADD CONSTRAINT "plan_action_states_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "policies" ADD CONSTRAINT "policies_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auto_approvals_business_id_currency_created_at_idx" ON "auto_approvals" USING btree ("business_id","currency","created_at");--> statement-breakpoint
CREATE INDEX "fx_quote_uses_business_id_idx" ON "fx_quote_uses" USING btree ("business_id");--> statement-breakpoint
CREATE INDEX "plan_action_states_business_id_status_idx" ON "plan_action_states" USING btree ("business_id","status");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_kind_check" CHECK ("kind" IN ('rfi_answer', 'conversion', 'payout'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_fee_option_check" CHECK ("fee_option" IN ('DEFAULT', 'PAYER', 'BENEFICIARY'));--> statement-breakpoint
-- M3-03 (ADR 0011): a policy version, an auto-approval and a quote use are records of what was allowed
-- and why; they are never changed or removed (the app role may INSERT and SELECT only, as audit_log).
REVOKE UPDATE, DELETE ON TABLE "policies" FROM carnet_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "auto_approvals" FROM carnet_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "fx_quote_uses" FROM carnet_app;
