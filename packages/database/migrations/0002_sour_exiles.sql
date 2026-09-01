CREATE TABLE IF NOT EXISTS "wallet_trade" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"mint" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"buy_count" integer NOT NULL,
	"sell_count" integer NOT NULL,
	"total_sol_in" numeric NOT NULL,
	"total_sol_out" numeric NOT NULL,
	"tokens_bought" numeric NOT NULL,
	"tokens_sold" numeric NOT NULL,
	"realized_return_pct" numeric,
	"won" boolean,
	"holding_period_sec" bigint,
	"flags" text[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_trade_wallet_mint_idx" ON "wallet_trade" USING btree ("wallet","mint");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_trade_wallet_opened_idx" ON "wallet_trade" USING btree ("wallet","opened_at");