CREATE TABLE "evidence_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"flag" text NOT NULL,
	"rules" jsonb NOT NULL,
	"reasons" jsonb NOT NULL,
	"fact_version_ids" jsonb NOT NULL,
	"check_hash" text NOT NULL,
	"cause" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_checks_flag_check" CHECK ("flag" IN ('strong', 'weak', 'missing')),
	CONSTRAINT "evidence_checks_cause_check" CHECK ("cause" IN ('link_added', 'link_removed', 'facts_confirmed', 'send')),
	CONSTRAINT "evidence_checks_hash_check" CHECK ("check_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "evidence_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"fact_version_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_links_id_business_id_key" UNIQUE("id","business_id")
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "evidence_policy" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "evidence_checks" ADD CONSTRAINT "evidence_checks_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_fact_version_id_document_facts_id_fk" FOREIGN KEY ("fact_version_id") REFERENCES "public"."document_facts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_links" ADD CONSTRAINT "evidence_links_document_same_business_fk" FOREIGN KEY ("document_id","business_id") REFERENCES "public"."documents"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "evidence_checks_business_id_payment_id_idx" ON "evidence_checks" USING btree ("business_id","payment_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_links_payment_document_key" ON "evidence_links" USING btree ("payment_id","document_id");--> statement-breakpoint
CREATE INDEX "evidence_links_business_id_payment_id_idx" ON "evidence_links" USING btree ("business_id","payment_id");--> statement-breakpoint
-- M2-03: a stored evidence check is a record of what the owner was shown; it is never changed or removed.
-- The app role may only INSERT and SELECT (as audit_log, plans and document_facts). It has no foreign key
-- to payments, so the history stays when a payment row is gone.
REVOKE UPDATE, DELETE ON TABLE "evidence_checks" FROM carnet_app;
