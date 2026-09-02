CREATE TABLE IF NOT EXISTS "paper_portfolio" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_agent_id" text NOT NULL,
	"starting_cash" numeric NOT NULL,
	"cash" numeric NOT NULL,
	"equity" numeric NOT NULL,
	"peak_equity" numeric NOT NULL,
	"max_drawdown" numeric DEFAULT '0' NOT NULL,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_position" (
	"id" text PRIMARY KEY NOT NULL,
	"portfolio_id" text NOT NULL,
	"prediction_id" text NOT NULL,
	"symbol" text NOT NULL,
	"domain" text NOT NULL,
	"direction" text NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"entry_price" numeric NOT NULL,
	"size" numeric NOT NULL,
	"remaining_size" numeric NOT NULL,
	"current_stop" numeric NOT NULL,
	"take_profit" numeric,
	"ladder_state" jsonb,
	"opened_at_event" timestamp with time zone NOT NULL,
	"opened_at_processing" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"close_reason" text,
	"realized_pnl" numeric DEFAULT '0' NOT NULL,
	"mfe" numeric DEFAULT '0' NOT NULL,
	"mae" numeric DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_position_fill" (
	"id" text PRIMARY KEY NOT NULL,
	"position_id" text NOT NULL,
	"fill_at_event" timestamp with time zone NOT NULL,
	"fill_at_processing" timestamp with time zone NOT NULL,
	"size_fraction" numeric NOT NULL,
	"price" numeric NOT NULL,
	"reason" text NOT NULL,
	"is_final" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "paper_position_originating_wallet" (
	"position_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"cluster_id" text,
	"entry_usd" numeric DEFAULT '0' NOT NULL,
	"entry_weight" numeric NOT NULL,
	"entry_score" numeric,
	"current_held_fraction" numeric DEFAULT '1' NOT NULL,
	CONSTRAINT "paper_position_originating_wallet_position_id_wallet_id_pk" PRIMARY KEY("position_id","wallet_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "paper_position_prediction_uq" ON "paper_position" USING btree ("prediction_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_position_portfolio_state_idx" ON "paper_position" USING btree ("portfolio_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "paper_position_fill_position_idx" ON "paper_position_fill" USING btree ("position_id");