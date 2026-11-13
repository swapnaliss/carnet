CREATE TABLE "criticality_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"obligation_id" uuid NOT NULL,
	"proposal_key" text NOT NULL,
	"proposed_criticality" smallint,
	"rationale" text DEFAULT '' NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"quote_page" integer,
	"document_id" uuid NOT NULL,
	"agent_run_id" uuid,
	"verifier_result" text NOT NULL,
	"verifier_reason" text,
	"status" text NOT NULL,
	"injection_suspected" boolean DEFAULT false NOT NULL,
	"injection_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prompt_version" text,
	"model" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "criticality_proposals_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "criticality_proposals_range_check" CHECK ("criticality_proposals"."proposed_criticality" IN (1, 2, 3)),
	CONSTRAINT "criticality_proposals_status_check" CHECK ("status" IN ('PROPOSED', 'CONFIRMED', 'OVERRIDDEN', 'REJECTED')),
	CONSTRAINT "criticality_proposals_verifier_check" CHECK ("verifier_result" IN ('VERIFIED', 'REJECTED')),
	CONSTRAINT "criticality_proposals_rejected_check" CHECK (("criticality_proposals"."verifier_result" = 'REJECTED') = ("criticality_proposals"."status" = 'REJECTED')),
	CONSTRAINT "criticality_proposals_verified_check" CHECK ("criticality_proposals"."verifier_result" = 'REJECTED' OR ("criticality_proposals"."proposed_criticality" IS NOT NULL AND "criticality_proposals"."quote_page" IS NOT NULL AND length("criticality_proposals"."quote") > 0)),
	CONSTRAINT "criticality_proposals_reason_check" CHECK (("criticality_proposals"."verifier_result" = 'REJECTED') = ("criticality_proposals"."verifier_reason" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"criticality" smallint,
	"criticality_confirmed_by" uuid,
	"criticality_confirmed_at" timestamp with time zone,
	"criticality_confirmed_proposal_id" uuid,
	"payment_id" uuid,
	"source_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "obligations_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "obligations_amount_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "obligations_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "obligations_criticality_range_check" CHECK ("obligations"."criticality" IN (1, 2, 3)),
	CONSTRAINT "obligations_criticality_confirmed_check" CHECK ("obligations"."criticality" IS NULL OR "obligations"."criticality_confirmed_by" IS NOT NULL),
	CONSTRAINT "obligations_confirmed_pair_check" CHECK (("obligations"."criticality_confirmed_by" IS NULL) = ("obligations"."criticality_confirmed_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "criticality_proposals" ADD CONSTRAINT "criticality_proposals_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criticality_proposals" ADD CONSTRAINT "criticality_proposals_obligation_same_business_fk" FOREIGN KEY ("obligation_id","business_id") REFERENCES "public"."obligations"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "criticality_proposals" ADD CONSTRAINT "criticality_proposals_document_same_business_fk" FOREIGN KEY ("document_id","business_id") REFERENCES "public"."documents"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_criticality_confirmed_by_users_id_fk" FOREIGN KEY ("criticality_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_counterparty_same_business_fk" FOREIGN KEY ("counterparty_id","business_id") REFERENCES "public"."counterparties"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_source_document_same_business_fk" FOREIGN KEY ("source_document_id","business_id") REFERENCES "public"."documents"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "criticality_proposals_key_key" ON "criticality_proposals" USING btree ("business_id","obligation_id","proposal_key");--> statement-breakpoint
CREATE INDEX "criticality_proposals_obligation_idx" ON "criticality_proposals" USING btree ("business_id","obligation_id","created_at");--> statement-breakpoint
CREATE INDEX "obligations_business_id_due_at_idx" ON "obligations" USING btree ("business_id","due_at");