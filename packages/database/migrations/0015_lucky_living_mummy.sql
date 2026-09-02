CREATE TABLE IF NOT EXISTS "llm_call_log" (
	"id" text PRIMARY KEY NOT NULL,
	"prediction_id" text,
	"signal_id" text,
	"agent" text NOT NULL,
	"agent_version" integer NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer NOT NULL,
	"completion_tokens" integer NOT NULL,
	"cost" numeric NOT NULL,
	"latency_ms" integer NOT NULL,
	"success" boolean NOT NULL,
	"error_kind" text,
	"called_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_log_prediction_idx" ON "llm_call_log" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "llm_call_log_called_at_agent_idx" ON "llm_call_log" USING btree ("called_at","agent");