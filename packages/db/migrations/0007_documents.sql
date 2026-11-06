CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" text NOT NULL,
	"bytes" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "documents_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "documents_kind_check" CHECK ("kind" IN ('invoice', 'contract', 'purchase_order', 'statement', 'other')),
	CONSTRAINT "documents_mime_check" CHECK ("mime" IN ('application/pdf', 'image/jpeg', 'image/png')),
	CONSTRAINT "documents_filename_check" CHECK (char_length("documents"."filename") BETWEEN 1 AND 50),
	CONSTRAINT "documents_size_check" CHECK ("documents"."size" > 0 AND "documents"."size" = octet_length("documents"."bytes")),
	CONSTRAINT "documents_sha256_check" CHECK ("documents"."sha256" = encode(sha256("documents"."bytes"), 'hex'))
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_business_id_created_at_idx" ON "documents" USING btree ("business_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "documents_business_id_sha256_key" ON "documents" USING btree ("business_id","sha256");
--> statement-breakpoint
-- M2-01 (ADR 0003): stored bytes and their hash are immutable. Two layers:
-- 1. privileges: the app role may INSERT, SELECT and DELETE, and UPDATE only kind and filename;
-- 2. a trigger refuses a change to bytes, sha256, size, mime or business_id for every role, the owner
--    included, so the hash an approval binds (ADR 0008) always describes the stored bytes.
REVOKE UPDATE ON TABLE "documents" FROM carnet_app;
--> statement-breakpoint
GRANT UPDATE ("kind", "filename") ON TABLE "documents" TO carnet_app;
--> statement-breakpoint
CREATE FUNCTION documents_refuse_content_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bytes IS DISTINCT FROM OLD.bytes
     OR NEW.sha256 IS DISTINCT FROM OLD.sha256
     OR NEW.size IS DISTINCT FROM OLD.size
     OR NEW.mime IS DISTINCT FROM OLD.mime
     OR NEW.business_id IS DISTINCT FROM OLD.business_id THEN
    RAISE EXCEPTION 'documents: bytes, sha256, size, mime and business_id are immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER documents_immutable_content BEFORE UPDATE ON "documents"
  FOR EACH ROW EXECUTE FUNCTION documents_refuse_content_change();
