ALTER TABLE "prediction" ADD COLUMN IF NOT EXISTS "brain_written_at" timestamp with time zone;
--> statement-breakpoint
-- m6-outcome-engine: refine the rule-10 immutability trigger to allow the ONE bookkeeping
-- transition `brain_written_at NULL → non-NULL` — a one-way stamp that records "this row has
-- already fed the Brain," outside §19's field set. Every OTHER change to a prediction row still
-- raises. This preserves the intent of rule 10 (predictions are the audit trail; §22 attribution
-- and §32 metrics cannot silently drift) while letting the outcome sweep guard against
-- double-writing the Brain under concurrent runs.
CREATE OR REPLACE FUNCTION prediction_no_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prediction is INSERT-only (rule 10 / §19); prediction_id=%', OLD.id;
  END IF;
  -- Allow the one-way brain_written_at stamp; every §19 field must be unchanged.
  IF OLD.brain_written_at IS NULL
     AND NEW.brain_written_at IS NOT NULL
     AND NEW.id                = OLD.id
     AND NEW.trading_agent_id  = OLD.trading_agent_id
     AND NEW.signal_id         = OLD.signal_id
     AND NEW.domain            = OLD.domain
     AND NEW.symbol            = OLD.symbol
     AND NEW.direction         = OLD.direction
     AND NEW.score             = OLD.score
     AND NEW.confidence        = OLD.confidence
     AND NEW.horizon           = OLD.horizon
     AND NEW.entry             = OLD.entry
     AND NEW.stop_loss         = OLD.stop_loss
     AND NEW.take_profit    IS NOT DISTINCT FROM OLD.take_profit
     AND NEW.position_size     = OLD.position_size
     AND NEW.notional          = OLD.notional
     AND NEW.leverage       IS NOT DISTINCT FROM OLD.leverage
     AND NEW.required_margin IS NOT DISTINCT FROM OLD.required_margin
     AND NEW.risk_reward       = OLD.risk_reward
     AND NEW.thesis         IS NOT DISTINCT FROM OLD.thesis
     AND NEW.config_version    = OLD.config_version
     AND NEW.is_shadow         = OLD.is_shadow
     AND NEW.shadow_of      IS NOT DISTINCT FROM OLD.shadow_of
     AND NEW.created_at        = OLD.created_at
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'prediction is INSERT-only (rule 10 / §19); prediction_id=%', COALESCE(NEW.id, OLD.id);
END;
$$ LANGUAGE plpgsql;
