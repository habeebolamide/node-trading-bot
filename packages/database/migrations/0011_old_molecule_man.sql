CREATE TABLE "paper_capital_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"account_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"trade_id" uuid,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"event_time" bigint NOT NULL,
	CONSTRAINT "paper_capital_ledger_source_unique" UNIQUE("source")
);
--> statement-breakpoint
CREATE TABLE "paper_reservations" (
	"trade_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"approval" jsonb NOT NULL,
	"reserved" numeric(38, 18) NOT NULL,
	"committed" numeric(38, 18) NOT NULL,
	"notional" numeric(38, 18) NOT NULL,
	"stop_exposure" numeric(38, 18) NOT NULL,
	CONSTRAINT "reservation_nonnegative" CHECK ("paper_reservations"."reserved">=0 AND "paper_reservations"."committed">=0 AND "paper_reservations"."notional">=0 AND "paper_reservations"."stop_exposure">=0)
);
--> statement-breakpoint
CREATE TABLE "paper_marks" (
	"bot_id" uuid PRIMARY KEY NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"event_time" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paper_execution_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"bot_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	CONSTRAINT "paper_execution_reports_event_key_unique" UNIQUE("event_key")
);
--> statement-breakpoint
ALTER TABLE "trade_lifecycles" DROP CONSTRAINT "trade_backend";--> statement-breakpoint
ALTER TABLE "paper_capital_ledger" ADD CONSTRAINT "paper_capital_ledger_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_capital_ledger" ADD CONSTRAINT "paper_capital_ledger_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_capital_ledger" ADD CONSTRAINT "paper_capital_ledger_trade_id_trade_lifecycles_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trade_lifecycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_reservations" ADD CONSTRAINT "paper_reservations_trade_id_trade_lifecycles_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trade_lifecycles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_reservations" ADD CONSTRAINT "paper_reservations_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_reservations" ADD CONSTRAINT "paper_reservations_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_marks" ADD CONSTRAINT "paper_marks_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_execution_reports" ADD CONSTRAINT "paper_execution_reports_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_execution_reports" ADD CONSTRAINT "paper_execution_reports_action_id_runtime_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."runtime_actions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_lifecycles" ADD CONSTRAINT "trade_backend" CHECK ("trade_lifecycles"."execution_backend" IN ('FAKE_CONTRACT','PAPER'));