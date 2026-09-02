CREATE TABLE IF NOT EXISTS "learning_hypothesis" (
	"id" text PRIMARY KEY NOT NULL,
	"setup_id" text NOT NULL,
	"domain" text NOT NULL,
	"category" text NOT NULL,
	"category_kind" text NOT NULL,
	"evidence_count" numeric NOT NULL,
	"proposed_change" jsonb NOT NULL,
	"status" text NOT NULL,
	"backtest_result" jsonb,
	"oos_result" jsonb,
	"from_config_version" integer,
	"to_config_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_hypothesis_status_setup_idx" ON "learning_hypothesis" USING btree ("status","setup_id");