CREATE TABLE IF NOT EXISTS "domain_event" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"processing_time" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"correlation_id" text,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "funding_rate" (
	"symbol" text NOT NULL,
	"funding_time" timestamp with time zone NOT NULL,
	"rate" numeric NOT NULL,
	CONSTRAINT "funding_rate_symbol_funding_time_pk" PRIMARY KEY("symbol","funding_time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "market_candle" (
	"symbol" text NOT NULL,
	"timeframe" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"close_time" timestamp with time zone NOT NULL,
	"open" numeric NOT NULL,
	"high" numeric NOT NULL,
	"low" numeric NOT NULL,
	"close" numeric NOT NULL,
	"volume" numeric NOT NULL,
	"turnover" numeric,
	CONSTRAINT "market_candle_symbol_timeframe_open_time_pk" PRIMARY KEY("symbol","timeframe","open_time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "open_interest" (
	"symbol" text NOT NULL,
	"snapshot_time" timestamp with time zone NOT NULL,
	"oi" numeric NOT NULL,
	CONSTRAINT "open_interest_symbol_snapshot_time_pk" PRIMARY KEY("symbol","snapshot_time")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "processed_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token" (
	"mint" text PRIMARY KEY NOT NULL,
	"symbol" text,
	"name" text,
	"decimals" integer,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_transaction" (
	"id" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"action" text NOT NULL,
	"mint" text NOT NULL,
	"amount_usd" numeric NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"tx_hash" text NOT NULL,
	"slot" bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "domain_event_type_time_idx" ON "domain_event" USING btree ("type","event_time");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "wallet_transaction_tx_hash_uq" ON "wallet_transaction" USING btree ("tx_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_transaction_wallet_time_idx" ON "wallet_transaction" USING btree ("wallet","block_time");