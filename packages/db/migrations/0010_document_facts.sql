CREATE TABLE "document_facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"extraction_key" text,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"failure" text,
	"prompt_version" text,
	"model" text,
	"text_layer" boolean NOT NULL,
	"facts" jsonb NOT NULL,
	"quotes" jsonb NOT NULL,
	"quotes_verified" boolean NOT NULL,
	"owner_confirmed_by" uuid,
	"injection_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_facts_document_version_key" UNIQUE("business_id","document_id","version"),
	CONSTRAINT "document_facts_version_check" CHECK ("document_facts"."version" >= 1),
	CONSTRAINT "document_facts_source_check" CHECK ("source" IN ('model', 'owner')),
	CONSTRAINT "document_facts_status_check" CHECK ("status" IN ('EXTRACTED', 'EXTRACTION_FAILED')),
	CONSTRAINT "document_facts_failure_check" CHECK (("document_facts"."status" = 'EXTRACTION_FAILED') = ("document_facts"."failure" IS NOT NULL)),
	CONSTRAINT "document_facts_owner_check" CHECK (("document_facts"."source" = 'owner') = ("document_facts"."owner_confirmed_by" IS NOT NULL)),
	CONSTRAINT "document_facts_facts_check" CHECK (jsonb_typeof("document_facts"."facts") = 'array' AND jsonb_typeof("document_facts"."quotes") = 'array' AND jsonb_typeof("document_facts"."injection_flags") = 'array')
);
--> statement-breakpoint
ALTER TABLE "document_facts" ADD CONSTRAINT "document_facts_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_facts" ADD CONSTRAINT "document_facts_owner_confirmed_by_users_id_fk" FOREIGN KEY ("owner_confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_facts" ADD CONSTRAINT "document_facts_document_same_business_fk" FOREIGN KEY ("document_id","business_id") REFERENCES "public"."documents"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_facts_extraction_key_key" ON "document_facts" USING btree ("business_id","document_id","extraction_key");--> statement-breakpoint
CREATE INDEX "document_facts_document_id_idx" ON "document_facts" USING btree ("business_id","document_id");--> statement-breakpoint
-- M2-02 (ADR 0010): a stored version of a document's facts is never changed or removed. Two layers:
-- 1. privileges: the app role may only INSERT and SELECT (as audit_log and plans);
-- 2. a trigger refuses UPDATE and DELETE for every role, the owner included.
REVOKE UPDATE, DELETE ON TABLE "document_facts" FROM carnet_app;
--> statement-breakpoint
CREATE FUNCTION document_facts_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_facts versions are immutable: insert version n+1 instead'
    USING ERRCODE = 'restrict_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER document_facts_immutable BEFORE UPDATE OR DELETE ON "document_facts"
  FOR EACH ROW EXECUTE FUNCTION document_facts_refuse_change();
