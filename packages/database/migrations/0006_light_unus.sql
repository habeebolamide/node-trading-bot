CREATE TABLE IF NOT EXISTS "agent_performance" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_agent_id" text NOT NULL,
	"agent_key" text NOT NULL,
	"agent_version" integer NOT NULL,
	"wins" integer DEFAULT 0 NOT NULL,
	"losses" integer DEFAULT 0 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_agent_memory" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"agent_key" text NOT NULL,
	"agent_version" integer NOT NULL,
	"standalone_accuracy" numeric,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scoring_config" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trading_agent" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"universe" text[] NOT NULL,
	"trading_style" text NOT NULL,
	"active_config_version" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "agent_performance_key_uq" ON "agent_performance" USING btree ("trading_agent_id","agent_key","agent_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brain_agent_memory_key_uq" ON "brain_agent_memory" USING btree ("domain","agent_key","agent_version");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "scoring_config_agent_version_uq" ON "scoring_config" USING btree ("trading_agent_id","version");