CREATE TABLE IF NOT EXISTS "active_token_claim" (
	"mint" text PRIMARY KEY NOT NULL,
	"trading_agent_id" text NOT NULL,
	"position_id" text,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);
