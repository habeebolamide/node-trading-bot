CREATE TABLE "strategy_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"config_snapshot_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"trigger_type" text NOT NULL,
	"trigger_event_key" text NOT NULL,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"event_time" bigint NOT NULL,
	"decision_time" bigint NOT NULL,
	"snapshot" jsonb NOT NULL,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "evaluation_decision" CHECK ("strategy_evaluations"."decision" IN ('LONG','SHORT','NO_TRADE')),
	CONSTRAINT "evaluation_trigger" CHECK ("strategy_evaluations"."trigger_type" IN ('CANDLE_CLOSE','MARKET_EVENT')),
	CONSTRAINT "evaluation_time" CHECK ("strategy_evaluations"."config_version">0 AND "strategy_evaluations"."event_time">=0 AND "strategy_evaluations"."decision_time">="strategy_evaluations"."event_time")
);
--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_config_snapshot_id_bot_config_versions_id_fk" FOREIGN KEY ("config_snapshot_id") REFERENCES "public"."bot_config_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_evaluations" ADD CONSTRAINT "strategy_evaluations_bot_id_account_id_bots_id_exchange_account_id_fk" FOREIGN KEY ("bot_id","account_id") REFERENCES "public"."bots"("id","exchange_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_strategy_eval_event" ON "strategy_evaluations" USING btree ("bot_id","strategy_version_id","trigger_type","trigger_event_key");