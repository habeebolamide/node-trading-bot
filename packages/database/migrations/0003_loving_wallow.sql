CREATE TABLE IF NOT EXISTS "brain_wallet_memory" (
	"wallet_id" text PRIMARY KEY NOT NULL,
	"early_entry" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trade_outcome" (
	"id" text PRIMARY KEY NOT NULL,
	"trade_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"mint" text NOT NULL,
	"entry_at" timestamp with time zone NOT NULL,
	"entry_price_sol" numeric NOT NULL,
	"forward_returns" jsonb NOT NULL,
	"peak_return" numeric,
	"coverage" numeric NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet" (
	"address" text PRIMARY KEY NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_scored_at" timestamp with time zone,
	"trade_count" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'unrated' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_score_event" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet_id" text NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"score" numeric NOT NULL,
	"config_version" integer NOT NULL,
	"inputs_used" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_scoring_config" (
	"version" integer PRIMARY KEY NOT NULL,
	"weights" jsonb NOT NULL,
	"prior_alpha" numeric NOT NULL,
	"prior_beta" numeric NOT NULL,
	"unrated_min_trades" integer DEFAULT 10 NOT NULL,
	"recompute_every_n_trades" integer DEFAULT 25 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "trade_outcome_wallet_idx" ON "trade_outcome" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_score_event_wallet_ts_idx" ON "wallet_score_event" USING btree ("wallet_id","timestamp");