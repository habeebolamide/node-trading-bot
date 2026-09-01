CREATE TABLE IF NOT EXISTS "signal_risk" (
	"signal_id" text PRIMARY KEY NOT NULL,
	"risk_level" text NOT NULL,
	"risk_flags" text[] DEFAULT '{}' NOT NULL,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_version" integer NOT NULL
);
