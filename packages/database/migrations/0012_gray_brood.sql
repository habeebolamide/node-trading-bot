CREATE TABLE IF NOT EXISTS "prediction" (
	"id" text PRIMARY KEY NOT NULL,
	"trading_agent_id" text NOT NULL,
	"signal_id" text NOT NULL,
	"domain" text NOT NULL,
	"symbol" text NOT NULL,
	"direction" text NOT NULL,
	"score" numeric NOT NULL,
	"confidence" numeric NOT NULL,
	"horizon" text NOT NULL,
	"entry" numeric NOT NULL,
	"stop_loss" numeric NOT NULL,
	"take_profit" numeric,
	"position_size" numeric NOT NULL,
	"notional" numeric NOT NULL,
	"leverage" numeric,
	"required_margin" numeric,
	"risk_reward" numeric NOT NULL,
	"thesis" text,
	"features" jsonb NOT NULL,
	"invalidators" jsonb,
	"config_version" integer NOT NULL,
	"is_shadow" boolean DEFAULT false NOT NULL,
	"shadow_of" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "prediction_outcome" (
	"prediction_id" text NOT NULL,
	"horizon" text NOT NULL,
	"resolved_at" timestamp with time zone NOT NULL,
	"return_pct" numeric NOT NULL,
	"benchmark_return_pct" numeric,
	"alpha" numeric,
	"mfe" numeric,
	"mae" numeric,
	"hit_target" boolean DEFAULT false NOT NULL,
	"hit_invalidation" boolean DEFAULT false NOT NULL,
	"holding_period_sec" bigint,
	"won" boolean NOT NULL,
	"outcome_resolution" text NOT NULL,
	CONSTRAINT "prediction_outcome_prediction_id_horizon_pk" PRIMARY KEY("prediction_id","horizon")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_no_trade" (
	"signal_id" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"vetoed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prediction_signal_uq" ON "prediction" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "prediction_agent_created_idx" ON "prediction" USING btree ("trading_agent_id","created_at");
--> statement-breakpoint
-- Rule 10 (§19): Predictions are locked after creation. A Postgres trigger enforces this
-- structurally rather than by convention — a retroactively-edited prediction would silently
-- destroy every §22 attribution and §32 metric that depends on it, and CLAUDE.md/§29 require
-- correctness to live in the DB, not the app. `prediction_outcome` is DELIBERATELY NOT locked:
-- change 4 fills a row per horizon as each elapses, so it accrues over time by design.
CREATE OR REPLACE FUNCTION prediction_no_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'prediction is INSERT-only (rule 10 / §19); prediction_id=%', COALESCE(OLD.id, NEW.id);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS prediction_no_update ON prediction;
CREATE TRIGGER prediction_no_update BEFORE UPDATE ON prediction
  FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation();

DROP TRIGGER IF EXISTS prediction_no_delete ON prediction;
CREATE TRIGGER prediction_no_delete BEFORE DELETE ON prediction
  FOR EACH ROW EXECUTE FUNCTION prediction_no_mutation();
