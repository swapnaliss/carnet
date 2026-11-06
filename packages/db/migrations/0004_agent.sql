CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "agent_runs_id_business_id_key" UNIQUE("id","business_id"),
	CONSTRAINT "agent_runs_status_check" CHECK ("status" IN ('RUNNING', 'DONE', 'FAILED')),
	CONSTRAINT "agent_runs_cost_check" CHECK ("cost_nano_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "agent_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"step" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"output" jsonb,
	"stop_reason" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_nano_usd" bigint DEFAULT 0 NOT NULL,
	"latency_ms" integer NOT NULL,
	"provider_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_steps_outcome_check" CHECK ("outcome" IN ('ok', 'refused', 'truncated', 'provider_error')),
	CONSTRAINT "agent_steps_cost_check" CHECK ("cost_nano_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_business_id_businesses_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_run_same_business_fk" FOREIGN KEY ("run_id","business_id") REFERENCES "public"."agent_runs"("id","business_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_kind_ref_idx" ON "agent_runs" USING btree ("kind","ref");--> statement-breakpoint
CREATE INDEX "agent_steps_run_id_step_idx" ON "agent_steps" USING btree ("run_id","step");--> statement-breakpoint
CREATE INDEX "agent_steps_input_hash_idx" ON "agent_steps" USING btree ("input_hash");--> statement-breakpoint
CREATE INDEX "agent_steps_created_at_idx" ON "agent_steps" USING btree ("created_at");