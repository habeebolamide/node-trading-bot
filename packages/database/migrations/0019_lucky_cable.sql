CREATE TABLE IF NOT EXISTS "trade_autopsy" (
	"id" text PRIMARY KEY NOT NULL,
	"prediction_id" text NOT NULL,
	"setup_id" text NOT NULL,
	"outcome" text NOT NULL,
	"root_cause" text,
	"failure_category" text,
	"success_factor" text,
	"explanation" text,
	"contributing_factors" jsonb,
	"agent_failures" jsonb,
	"lesson" text,
	"recommendation" text,
	"autopsy_version" integer NOT NULL,
	"llm_call_log_id" text,
	"status" text DEFAULT 'SUCCESS' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "trade_autopsy_prediction_uq" ON "trade_autopsy" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_autopsy_setup_idx" ON "trade_autopsy" USING btree ("setup_id");
--> statement-breakpoint
-- m7-trade-autopsy: §24 "always exactly one of failureCategory / successFactor populated"
-- with a third clause allowing null-null on FAILED_LLM so a retry can UPDATE it in place.
ALTER TABLE trade_autopsy ADD CONSTRAINT trade_autopsy_outcome_xor CHECK (
  (outcome = 'WIN'  AND failure_category IS NULL      AND success_factor IS NOT NULL) OR
  (outcome = 'LOSS' AND failure_category IS NOT NULL  AND success_factor IS NULL)     OR
  (status  = 'FAILED_LLM' AND failure_category IS NULL AND success_factor IS NULL)
);
