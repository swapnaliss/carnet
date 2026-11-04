CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"business_id" uuid,
	"prev_hash" text,
	"hash" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"subject" text NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "businesses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"policy_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counterparties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"country" char(2) NOT NULL,
	"beneficiary_id" text,
	"account_fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "counterparties_id_business_id_key" UNIQUE("id","business_id")
);
--> statement-breakpoint
CREATE TABLE "execution_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"status" text DEFAULT 'INTENT' NOT NULL,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "execution_attempts_kind_check" CHECK ("kind" IN ('transfer', 'conversion', 'respond')),
	CONSTRAINT "execution_attempts_status_check" CHECK ("status" IN ('INTENT', 'SENT_TO_AIRWALLEX', 'CONFIRMED', 'UNKNOWN', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"business_id" uuid NOT NULL,
	"endpoint" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response_status" integer NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY("business_id","endpoint","key")
);
--> statement-breakpoint
CREATE TABLE "outbox_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_jobs_status_check" CHECK ("status" IN ('PENDING', 'RUNNING', 'DONE', 'RETRY', 'DEAD'))
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"counterparty_id" uuid,
	"obligation_id" uuid,
	"amount_minor" bigint NOT NULL,
	"currency" char(3) NOT NULL,
	"source_currency" char(3) NOT NULL,
	"method" text NOT NULL,
	"reference" text NOT NULL,
	"transfer_id" text,
	"transfer_status" text,
	"transfer_updated_at" timestamp with time zone,
	"failure_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_amount_minor_check" CHECK ("amount_minor" > 0),
	CONSTRAINT "payments_currency_check" CHECK ("currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_source_currency_check" CHECK ("source_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "payments_transfer_status_check" CHECK ("transfer_status" IN ('IN_APPROVAL', 'APPROVAL_RECALLED', 'APPROVAL_REJECTED', 'APPROVAL_BLOCKED', 'SCHEDULED', 'OVERDUE', 'PROCESSING', 'SENT', 'PAID', 'FAILED', 'CANCELLED'))
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limits_pkey" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "system_flags" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"agents_enabled" boolean DEFAULT true NOT NULL,
	"execution_enabled" boolean DEFAULT true NOT NULL,
	"daily_spend_cap_minor" bigint NOT NULL,
	"per_run_cap_minor" bigint NOT NULL,
	"cap_currency" char(3) DEFAULT 'USD' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_flags_singleton_check" CHECK ("system_flags"."id" = 1),
	CONSTRAINT "system_flags_cap_currency_check" CHECK ("cap_currency" ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_check" CHECK ("role" IN ('owner', 'approver', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_event_id" text NOT NULL,
	"name" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw_body" text NOT NULL,
	"signature_ok" boolean NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "counterparties" ADD CONSTRAINT "counterparties_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_attempts" ADD CONSTRAINT "execution_attempts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_counterparty_same_business_fk" FOREIGN KEY ("counterparty_id","business_id") REFERENCES "public"."counterparties"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_business_id_id_idx" ON "audit_log" USING btree ("business_id","id");--> statement-breakpoint
CREATE INDEX "counterparties_business_id_idx" ON "counterparties" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_attempts_request_id_key" ON "execution_attempts" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "execution_attempts_business_id_status_idx" ON "execution_attempts" USING btree ("business_id","status");--> statement-breakpoint
CREATE INDEX "outbox_jobs_status_run_after_idx" ON "outbox_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "payments_business_id_transfer_status_idx" ON "payments" USING btree ("business_id","transfer_status");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_transfer_id_key" ON "payments" USING btree ("transfer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_business_id_idx" ON "users" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_events_provider_event_id_key" ON "webhook_events" USING btree ("provider_event_id");