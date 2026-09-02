DROP INDEX IF EXISTS "prediction_signal_uq";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "prediction_signal_real_uq" ON "prediction" USING btree ("signal_id") WHERE is_shadow = false;