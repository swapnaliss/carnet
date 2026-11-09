CREATE TABLE "answer_memory" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"counterparty_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"fp_version" integer NOT NULL,
	"answer_type" text NOT NULL,
	"question_id" uuid NOT NULL,
	"answer_text" text NOT NULL,
	"citations" jsonb NOT NULL,
	"attachments" jsonb NOT NULL,
	"source_approval_id" uuid NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "answer_memory_fingerprint_check" CHECK ("answer_memory"."fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "answer_memory_fp_version_check" CHECK ("fp_version" >= 1),
	CONSTRAINT "answer_memory_json_check" CHECK (jsonb_typeof("citations") = 'array' AND jsonb_typeof("attachments") = 'array')
);
--> statement-breakpoint
ALTER TABLE "answer_memory" ADD CONSTRAINT "answer_memory_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_memory" ADD CONSTRAINT "answer_memory_source_approval_id_approvals_id_fk" FOREIGN KEY ("source_approval_id") REFERENCES "public"."approvals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_memory" ADD CONSTRAINT "answer_memory_counterparty_same_business_fk" FOREIGN KEY ("counterparty_id","business_id") REFERENCES "public"."counterparties"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "answer_memory" ADD CONSTRAINT "answer_memory_question_same_business_fk" FOREIGN KEY ("question_id","business_id") REFERENCES "public"."rfi_questions"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "answer_memory_lookup_idx" ON "answer_memory" USING btree ("business_id","counterparty_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "answer_memory_approval_question_key" ON "answer_memory" USING btree ("source_approval_id","question_id");--> statement-breakpoint
-- M2-06: a remembered answer is never changed or removed; a newer approval inserts a newer row. Two
-- layers, as for drafts: the app role may only INSERT and SELECT, and a trigger refuses UPDATE and DELETE
-- for every role, the owner included.
REVOKE UPDATE, DELETE ON TABLE "answer_memory" FROM carnet_app;
--> statement-breakpoint
CREATE FUNCTION answer_memory_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: a newer approval inserts a newer row', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER answer_memory_immutable BEFORE UPDATE OR DELETE ON "answer_memory"
  FOR EACH ROW EXECUTE FUNCTION answer_memory_refuse_change();
