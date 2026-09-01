CREATE TABLE IF NOT EXISTS "signal" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_agent_id" text NOT NULL,
	"symbol" text NOT NULL,
	"domain" text NOT NULL,
	"direction" text NOT NULL,
	"composite_score" numeric NOT NULL,
	"confidence" numeric NOT NULL,
	"state" text DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"config_version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"evidence" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_feature" (
	"signal_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"agent_version" integer NOT NULL,
	"score" numeric NOT NULL,
	"confidence" numeric NOT NULL,
	"features" jsonb NOT NULL,
	CONSTRAINT "signal_feature_signal_id_agent_key_agent_version_pk" PRIMARY KEY("signal_id","agent_key","agent_version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "signal_fingerprint_uq" ON "signal" USING btree ("fingerprint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_agent_state_idx" ON "signal" USING btree ("trading_agent_id","state");