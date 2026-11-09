-- The same-business foreign keys below need these unique keys first (drizzle emits them last).
ALTER TABLE "rfi_questions" ADD CONSTRAINT "rfi_questions_id_business_id_key" UNIQUE("id","business_id");--> statement-breakpoint
ALTER TABLE "rfis" ADD CONSTRAINT "rfis_id_business_id_key" UNIQUE("id","business_id");--> statement-breakpoint
CREATE TABLE "draft_answers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"text" text NOT NULL,
	"citations" jsonb NOT NULL,
	"document_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"verifier_result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_answers_draft_question_key" UNIQUE("draft_id","question_id"),
	CONSTRAINT "draft_answers_status_check" CHECK ("status" IN ('VERIFIED', 'NEEDS_OWNER', 'OWNER_AUTHORED')),
	CONSTRAINT "draft_answers_reason_check" CHECK (("status" = 'NEEDS_OWNER') = ("reason_code" IS NOT NULL)),
	CONSTRAINT "draft_answers_json_check" CHECK (jsonb_typeof("citations") = 'array' AND jsonb_typeof("document_ids") = 'array')
);
--> statement-breakpoint
CREATE TABLE "drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"rfi_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"parent_draft_id" uuid,
	"origin" text NOT NULL,
	"draft_key" text NOT NULL,
	"prompt_version" text,
	"model" text,
	"input_hash" text,
	"injection_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_run_id" uuid,
	"state" text NOT NULL,
	"blocking" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drafts_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "drafts_round_check" CHECK ("round" >= 1),
	CONSTRAINT "drafts_origin_check" CHECK ("origin" IN ('model', 'owner', 'system')),
	CONSTRAINT "drafts_state_check" CHECK ("state" IN ('DRAFT_READY', 'NEEDS_OWNER')),
	CONSTRAINT "drafts_owner_check" CHECK (("origin" = 'owner') = ("created_by" IS NOT NULL)),
	CONSTRAINT "drafts_json_check" CHECK (jsonb_typeof("injection_flags") = 'array' AND jsonb_typeof("blocking") = 'array')
);
--> statement-breakpoint
ALTER TABLE "draft_answers" ADD CONSTRAINT "draft_answers_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_answers" ADD CONSTRAINT "draft_answers_draft_same_business_fk" FOREIGN KEY ("draft_id","business_id") REFERENCES "public"."drafts"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_answers" ADD CONSTRAINT "draft_answers_question_same_business_fk" FOREIGN KEY ("question_id","business_id") REFERENCES "public"."rfi_questions"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_rfi_same_business_fk" FOREIGN KEY ("rfi_id","business_id") REFERENCES "public"."rfis"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drafts" ADD CONSTRAINT "drafts_parent_same_business_fk" FOREIGN KEY ("parent_draft_id","business_id") REFERENCES "public"."drafts"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "draft_answers_draft_id_idx" ON "draft_answers" USING btree ("business_id","draft_id");--> statement-breakpoint
CREATE UNIQUE INDEX "drafts_rfi_round_key_key" ON "drafts" USING btree ("business_id","rfi_id","round","draft_key");--> statement-breakpoint
CREATE INDEX "drafts_rfi_id_round_idx" ON "drafts" USING btree ("business_id","rfi_id","round");--> statement-breakpoint
-- M2-05 (ADR 0010): a draft and its answers are never changed or removed; an edit or a re-draft inserts a
-- new draft. Two layers, as for document_facts:
-- 1. privileges: the app role may only INSERT and SELECT;
-- 2. a trigger refuses UPDATE and DELETE for every role, the owner included.
REVOKE UPDATE, DELETE ON TABLE "drafts" FROM carnet_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "draft_answers" FROM carnet_app;
--> statement-breakpoint
CREATE FUNCTION drafts_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: insert a new draft instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER drafts_immutable BEFORE UPDATE OR DELETE ON "drafts"
  FOR EACH ROW EXECUTE FUNCTION drafts_refuse_change();
--> statement-breakpoint
CREATE TRIGGER draft_answers_immutable BEFORE UPDATE OR DELETE ON "draft_answers"
  FOR EACH ROW EXECUTE FUNCTION drafts_refuse_change();
