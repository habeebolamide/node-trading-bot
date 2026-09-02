CREATE TABLE IF NOT EXISTS "brain_agent_occurrence" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"agent_key" text NOT NULL,
	"agent_version" integer NOT NULL,
	"prediction_id" text NOT NULL,
	"closed_at" timestamp with time zone NOT NULL,
	"lean" integer NOT NULL,
	"won" boolean NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "effective_n" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "effective_wins" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "wilson_lower" numeric;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "wilson_upper" numeric;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "evidence" text DEFAULT 'INSUFFICIENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "occurrence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "sample_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "vetoed_count" integer;--> statement-breakpoint
ALTER TABLE "brain_agent_memory" ADD COLUMN "vetoed_would_have_lost" integer;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_agent_occurrence_pred_agent_uq" ON "brain_agent_occurrence" USING btree ("prediction_id","agent_key","agent_version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_agent_occurrence_agent_idx" ON "brain_agent_occurrence" USING btree ("domain","agent_key","agent_version");