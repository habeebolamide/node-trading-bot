CREATE TABLE IF NOT EXISTS "wallet_sell_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"tx_signature" text NOT NULL,
	"token_amount" numeric NOT NULL,
	"fraction_of_entry" numeric NOT NULL,
	"held_fraction_after" numeric NOT NULL,
	"accumulator_after" numeric NOT NULL,
	"crossed_threshold" boolean DEFAULT false NOT NULL,
	"observed_at_event" timestamp with time zone NOT NULL,
	"observed_at_processing" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_position_originating_wallet" ADD COLUMN "entry_token_amount" numeric;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_sell_observation_uq" ON "wallet_sell_observation" USING btree ("position_id","wallet_id","tx_signature");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_sell_observation_position_idx" ON "wallet_sell_observation" USING btree ("position_id");