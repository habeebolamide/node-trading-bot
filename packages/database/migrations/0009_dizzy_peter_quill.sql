CREATE TABLE IF NOT EXISTS "brain_setup_memory" (
	"setup_id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"effective_n" numeric NOT NULL,
	"effective_wins" numeric NOT NULL,
	"win_rate" numeric,
	"median_return" numeric,
	"wilson_lower" numeric,
	"wilson_upper" numeric,
	"evidence" text NOT NULL,
	"occurrence_count" integer DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_setup_occurrence" (
	"id" text PRIMARY KEY NOT NULL,
	"setup_id" text NOT NULL,
	"prediction_id" text NOT NULL,
	"domain" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"won" boolean NOT NULL,
	"return_pct" numeric NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_setup_occurrence_pred_setup_uq" ON "brain_setup_occurrence" USING btree ("prediction_id","setup_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_setup_occurrence_setup_idx" ON "brain_setup_occurrence" USING btree ("setup_id");