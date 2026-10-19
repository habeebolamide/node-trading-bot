CREATE TABLE "fake_execution_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"bot_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "fake_execution_reports_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
CREATE TABLE "runtime_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"trade_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"price" numeric(38, 18),
	"stop_price" numeric(38, 18),
	"take_profit" numeric(38, 18),
	"revision" integer NOT NULL,
	"reason" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "runtime_action_kind" CHECK ("runtime_actions"."kind" IN ('ENTRY','CANCEL_ENTRY','CLOSE','PROTECT','AMEND_STOP')),
	CONSTRAINT "runtime_action_state" CHECK ("runtime_actions"."state" IN ('CREATED','SUBMITTING','OPEN','CONFIRMED','FILLED','CANCELLED','REJECTED','UNKNOWN')),
	CONSTRAINT "runtime_action_qty" CHECK ("runtime_actions"."quantity">=0)
);
--> statement-breakpoint
CREATE TABLE "runtime_checkpoints" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"desired" text NOT NULL,
	"last_price_time" bigint NOT NULL,
	"last_candle_time" bigint NOT NULL,
	"last_evaluation_id" uuid,
	"fault" text,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "runtime_desired" CHECK ("runtime_checkpoints"."desired" IN ('RUNNING','PAUSED','STOPPED'))
);
--> statement-breakpoint
CREATE TABLE "runtime_commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"bot_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"actor_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"reason" text NOT NULL,
	"requested_at" bigint NOT NULL,
	"completed_at" bigint,
	"result" jsonb,
	"correlation_id" uuid NOT NULL,
	CONSTRAINT "command_kind" CHECK ("runtime_commands"."kind" IN ('START','PAUSE','RESUME','STOP')),
	CONSTRAINT "command_status" CHECK ("runtime_commands"."status" IN ('PENDING','APPLIED','REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "runtime_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"kind" text NOT NULL,
	"event_time" bigint NOT NULL,
	"fencing_token" bigint NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_leases" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"owner_instance_id" uuid NOT NULL,
	"fencing_token" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "positive_fence" CHECK ("runtime_leases"."fencing_token">0)
);
--> statement-breakpoint
CREATE TABLE "trade_lifecycles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"state" text NOT NULL,
	"side" text NOT NULL,
	"order_type" text NOT NULL,
	"execution_backend" text DEFAULT 'FAKE_CONTRACT' NOT NULL,
	"requested_quantity" numeric(38, 18) NOT NULL,
	"filled_quantity" numeric(38, 18) NOT NULL,
	"closed_quantity" numeric(38, 18) NOT NULL,
	"entry_reference" numeric(38, 18) NOT NULL,
	"average_entry" numeric(38, 18),
	"initial_stop" numeric(38, 18) NOT NULL,
	"desired_stop" numeric(38, 18) NOT NULL,
	"submitted_stop" numeric(38, 18),
	"confirmed_stop" numeric(38, 18),
	"take_profit" numeric(38, 18) NOT NULL,
	"protected_quantity" numeric(38, 18) NOT NULL,
	"protection_revision" integer NOT NULL,
	"confirmed_revision" integer NOT NULL,
	"protection_status" text NOT NULL,
	"entry_terminal" boolean NOT NULL,
	"expires_at" bigint NOT NULL,
	"opened_at" bigint,
	"created_at" bigint NOT NULL,
	"closed_at" bigint,
	"close_reason" text,
	"close_generation" integer NOT NULL,
	"pending_cancel_reason" text,
	"trailing_distance" numeric(38, 18),
	"policy" jsonb NOT NULL,
	CONSTRAINT "trade_backend" CHECK ("trade_lifecycles"."execution_backend"='FAKE_CONTRACT'),
	CONSTRAINT "trade_state" CHECK ("trade_lifecycles"."state" IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED','CLOSED','CANCELLED','EXPIRED')),
	CONSTRAINT "trade_side" CHECK ("trade_lifecycles"."side" IN ('LONG','SHORT')),
	CONSTRAINT "trade_order_type" CHECK ("trade_lifecycles"."order_type" IN ('MARKET','LIMIT')),
	CONSTRAINT "trade_quantities" CHECK ("trade_lifecycles"."requested_quantity">0 AND "trade_lifecycles"."filled_quantity">=0 AND "trade_lifecycles"."filled_quantity"<="trade_lifecycles"."requested_quantity" AND "trade_lifecycles"."closed_quantity">=0 AND "trade_lifecycles"."closed_quantity"<="trade_lifecycles"."filled_quantity" AND "trade_lifecycles"."protected_quantity">=0 AND "trade_lifecycles"."protected_quantity"<="trade_lifecycles"."filled_quantity"-"trade_lifecycles"."closed_quantity"),
	CONSTRAINT "trade_prices" CHECK ("trade_lifecycles"."entry_reference">0 AND "trade_lifecycles"."initial_stop">0 AND "trade_lifecycles"."desired_stop">0 AND "trade_lifecycles"."take_profit">0 AND ("trade_lifecycles"."average_entry" IS NULL OR "trade_lifecycles"."average_entry">0) AND ("trade_lifecycles"."confirmed_stop" IS NULL OR "trade_lifecycles"."confirmed_stop">0)),
	CONSTRAINT "protection_status" CHECK ("trade_lifecycles"."protection_status" IN ('UNCONFIRMED','REQUESTED','CONFIRMED','UNKNOWN'))
);
--> statement-breakpoint
ALTER TABLE "bots" DROP CONSTRAINT "phase1_stopped";--> statement-breakpoint
ALTER TABLE "fake_execution_reports" ADD CONSTRAINT "fake_execution_reports_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fake_execution_reports" ADD CONSTRAINT "fake_execution_reports_action_id_runtime_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."runtime_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_actions" ADD CONSTRAINT "runtime_actions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_actions" ADD CONSTRAINT "runtime_actions_trade_id_trade_lifecycles_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trade_lifecycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_checkpoints" ADD CONSTRAINT "runtime_checkpoints_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_checkpoints" ADD CONSTRAINT "runtime_checkpoints_last_evaluation_id_strategy_evaluations_id_fk" FOREIGN KEY ("last_evaluation_id") REFERENCES "public"."strategy_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_commands" ADD CONSTRAINT "runtime_commands_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_commands" ADD CONSTRAINT "runtime_commands_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_commands" ADD CONSTRAINT "runtime_commands_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_commands" ADD CONSTRAINT "runtime_commands_bot_id_account_id_bots_id_exchange_account_id_fk" FOREIGN KEY ("bot_id","account_id") REFERENCES "public"."bots"("id","exchange_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_leases" ADD CONSTRAINT "runtime_leases_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_lifecycles" ADD CONSTRAINT "trade_lifecycles_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_lifecycles" ADD CONSTRAINT "trade_lifecycles_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_lifecycles" ADD CONSTRAINT "trade_lifecycles_evaluation_id_strategy_evaluations_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "public"."strategy_evaluations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_lifecycles" ADD CONSTRAINT "trade_lifecycles_bot_id_account_id_bots_id_exchange_account_id_fk" FOREIGN KEY ("bot_id","account_id") REFERENCES "public"."bots"("id","exchange_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_action_idempotency" ON "runtime_actions" USING btree ("bot_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "command_idempotency" ON "runtime_commands" USING btree ("bot_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_event_idempotency" ON "runtime_events" USING btree ("bot_id","event_key");--> statement-breakpoint
CREATE UNIQUE INDEX "one_trade_per_evaluation" ON "trade_lifecycles" USING btree ("evaluation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "one_unresolved_lifecycle" ON "trade_lifecycles" USING btree ("bot_id") WHERE "trade_lifecycles"."state" IN ('PENDING_ENTRY','OPEN','CLOSING','UNRESOLVED');--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bot_operational_state" CHECK ("bots"."operational_status" IN ('STOPPED','STARTING','WARMING_UP','RUNNING','PAUSED','STOP_REQUESTED','RECONCILING','RISK_SUSPENDED','ERROR'));--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bot_trading_state" CHECK ("bots"."trading_state" IN ('IDLE','PENDING_ENTRY','IN_TRADE','CLOSING','UNRESOLVED'));