CREATE TABLE "rfi_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"rfi_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"airwallex_question_id" text NOT NULL,
	"position" integer NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"comment" text,
	"answer_type" text NOT NULL,
	"sources" jsonb NOT NULL,
	"reopened" boolean DEFAULT false NOT NULL,
	"needs_drafting" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfi_questions_round_check" CHECK ("round" >= 1)
);
--> statement-breakpoint
CREATE TABLE "rfis" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"airwallex_rfi_id" text NOT NULL,
	"type" text NOT NULL,
	"sub_type" text,
	"airwallex_status" text NOT NULL,
	"airwallex_updated_at" timestamp with time zone NOT NULL,
	"airwallex_answered_requests" integer DEFAULT 0 NOT NULL,
	"state" text NOT NULL,
	"round" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone,
	"expiring_soon" boolean DEFAULT false NOT NULL,
	"payment_id" uuid,
	"orphan_reason" text,
	"linked_by" text,
	"source_key" text,
	"conflict" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rfis_state_check" CHECK ("state" IN ('ACTION_REQUIRED', 'DRAFTING', 'DRAFT_READY', 'NEEDS_OWNER', 'APPROVED', 'ANSWER_SUBMITTING', 'ANSWERED', 'REOPENED', 'CLOSED', 'EXPIRED')),
	CONSTRAINT "rfis_airwallex_status_check" CHECK ("airwallex_status" IN ('ACTION_REQUIRED', 'ANSWERED', 'CLOSED')),
	CONSTRAINT "rfis_orphan_reason_check" CHECK ("orphan_reason" IN ('NO_SOURCES', 'NON_TRANSFER_SOURCE', 'UNKNOWN_TRANSFER', 'MULTIPLE_PAYMENTS', 'OWNER_UNLINKED')),
	CONSTRAINT "rfis_linked_by_check" CHECK ("linked_by" IN ('match', 'owner')),
	CONSTRAINT "rfis_round_check" CHECK ("round" >= 1),
	CONSTRAINT "rfis_link_xor_orphan_check" CHECK (("payment_id" IS NULL) = ("orphan_reason" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "businesses" ADD COLUMN "airwallex_account_id" text;--> statement-breakpoint
ALTER TABLE "rfi_questions" ADD CONSTRAINT "rfi_questions_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfi_questions" ADD CONSTRAINT "rfi_questions_rfi_id_rfis_id_fk" FOREIGN KEY ("rfi_id") REFERENCES "public"."rfis"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfis" ADD CONSTRAINT "rfis_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rfis" ADD CONSTRAINT "rfis_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "rfi_questions_rfi_round_question_key" ON "rfi_questions" USING btree ("rfi_id","round","airwallex_question_id");--> statement-breakpoint
CREATE INDEX "rfi_questions_business_id_rfi_id_idx" ON "rfi_questions" USING btree ("business_id","rfi_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rfis_business_id_airwallex_rfi_id_key" ON "rfis" USING btree ("business_id","airwallex_rfi_id");--> statement-breakpoint
CREATE INDEX "rfis_airwallex_rfi_id_idx" ON "rfis" USING btree ("airwallex_rfi_id");--> statement-breakpoint
CREATE INDEX "rfis_business_id_state_idx" ON "rfis" USING btree ("business_id","state");--> statement-breakpoint
CREATE INDEX "rfis_payment_id_idx" ON "rfis" USING btree ("payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rfis_one_open_per_source_key" ON "rfis" USING btree ("business_id","type","source_key") WHERE "conflict" = false AND "source_key" IS NOT NULL AND "state" NOT IN ('CLOSED', 'EXPIRED');--> statement-breakpoint
CREATE UNIQUE INDEX "businesses_airwallex_account_id_key" ON "businesses" USING btree ("airwallex_account_id");