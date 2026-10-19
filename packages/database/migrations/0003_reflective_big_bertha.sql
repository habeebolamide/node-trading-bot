CREATE TABLE "candles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"timeframe" text NOT NULL,
	"open_time" bigint NOT NULL,
	"close_time" bigint NOT NULL,
	"open" numeric(38, 18) NOT NULL,
	"high" numeric(38, 18) NOT NULL,
	"low" numeric(38, 18) NOT NULL,
	"close" numeric(38, 18) NOT NULL,
	"volume" numeric(38, 18) NOT NULL,
	"is_closed" boolean NOT NULL,
	"source" text NOT NULL,
	"observed_at" bigint NOT NULL,
	"available_at" bigint NOT NULL,
	CONSTRAINT "candle_closed_ohlc" CHECK ("candles"."is_closed"=true AND "candles"."open">0 AND "candles"."low">0 AND "candles"."volume">=0 AND "candles"."high">=greatest("candles"."open","candles"."close") AND "candles"."low"<=least("candles"."open","candles"."close") AND "candles"."high">="candles"."low"),
	CONSTRAINT "candle_time_availability" CHECK ("candles"."open_time">=0 AND "candles"."close_time"<="candles"."available_at" AND "candles"."available_at"<="candles"."observed_at"),
	CONSTRAINT "candle_timeframe_alignment" CHECK (CASE "candles"."timeframe" WHEN '1m' THEN "candles"."close_time"-"candles"."open_time"=60000 AND "candles"."open_time"%60000=0 WHEN '5m' THEN "candles"."close_time"-"candles"."open_time"=300000 AND "candles"."open_time"%300000=0 WHEN '15m' THEN "candles"."close_time"-"candles"."open_time"=900000 AND "candles"."open_time"%900000=0 WHEN '1h' THEN "candles"."close_time"-"candles"."open_time"=3600000 AND "candles"."open_time"%3600000=0 WHEN '4h' THEN "candles"."close_time"-"candles"."open_time"=14400000 AND "candles"."open_time"%14400000=0 ELSE false END)
);
--> statement-breakpoint
CREATE TABLE "instrument_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"spec_version" text NOT NULL,
	"spec_json" jsonb NOT NULL,
	"observed_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_instruments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_market_id" text NOT NULL,
	"exchange" text NOT NULL,
	"market_type" text NOT NULL,
	"symbol" text NOT NULL,
	"base_asset" text NOT NULL,
	"quote_asset" text NOT NULL,
	"spec_version" text NOT NULL,
	"spec_json" jsonb NOT NULL,
	"verified_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	CONSTRAINT "market_instruments_canonical_market_id_unique" UNIQUE("canonical_market_id"),
	CONSTRAINT "instrument_market_type" CHECK ("market_instruments"."market_type" IN ('SPOT','LINEAR_PERPETUAL')),
	CONSTRAINT "instrument_expiry" CHECK ("market_instruments"."expires_at">"market_instruments"."verified_at")
);
--> statement-breakpoint
CREATE TABLE "market_checkpoints" (
	"stream_key" text PRIMARY KEY NOT NULL,
	"instrument_id" uuid NOT NULL,
	"last_open_time" bigint,
	"last_event_time" bigint,
	"observed_at" bigint NOT NULL,
	"state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "market_data_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instrument_id" uuid NOT NULL,
	"stream" text NOT NULL,
	"start_time" bigint NOT NULL,
	"end_time" bigint NOT NULL,
	"status" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"observed_at" bigint NOT NULL,
	"resolved_at" bigint,
	CONSTRAINT "gap_status" CHECK ("market_data_gaps"."status" IN ('OPEN','RESOLVED','UNCERTAIN')),
	CONSTRAINT "gap_range" CHECK ("market_data_gaps"."end_time">"market_data_gaps"."start_time")
);
--> statement-breakpoint
ALTER TABLE "candles" ADD CONSTRAINT "candles_instrument_id_market_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."market_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instrument_versions" ADD CONSTRAINT "instrument_versions_instrument_id_market_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."market_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_checkpoints" ADD CONSTRAINT "market_checkpoints_instrument_id_market_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."market_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_data_gaps" ADD CONSTRAINT "market_data_gaps_instrument_id_market_instruments_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."market_instruments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candle_identity" ON "candles" USING btree ("instrument_id","timeframe","open_time");--> statement-breakpoint
CREATE UNIQUE INDEX "instrument_spec_unique" ON "instrument_versions" USING btree ("instrument_id","spec_version");--> statement-breakpoint
CREATE UNIQUE INDEX "market_gap_identity" ON "market_data_gaps" USING btree ("instrument_id","stream","start_time","end_time");