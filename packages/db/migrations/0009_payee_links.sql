CREATE TABLE "payee_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"disclosure_level" text DEFAULT 'GENERIC' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_viewed_at" timestamp with time zone,
	CONSTRAINT "payee_links_token_hash_check" CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payee_links_disclosure_level_check" CHECK ("disclosure_level" IN ('GENERIC', 'DELAYED_FOR_VERIFICATION'))
);
--> statement-breakpoint
ALTER TABLE "payee_links" ADD CONSTRAINT "payee_links_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_links" ADD CONSTRAINT "payee_links_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payee_links" ADD CONSTRAINT "payee_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payee_links_token_hash_key" ON "payee_links" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "payee_links_business_id_payment_id_idx" ON "payee_links" USING btree ("business_id","payment_id");