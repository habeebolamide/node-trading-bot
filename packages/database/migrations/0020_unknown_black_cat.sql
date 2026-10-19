CREATE TABLE "recovery_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"key" text NOT NULL,
	"start_time" bigint NOT NULL,
	"end_time" bigint,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"checkpoint" integer DEFAULT -1 NOT NULL,
	CONSTRAINT "recovery_gaps_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "replay_instruments" (
	"key" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"market_key" text NOT NULL,
	"snapshot" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"account_id" uuid,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"input_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"checkpoint" integer DEFAULT -1 NOT NULL,
	"lease_owner" uuid,
	"lease_until" timestamp with time zone,
	"report" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "replay_samples" (
	"key" text PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"event_time" bigint NOT NULL,
	"equity" numeric(38, 18) NOT NULL,
	"capacity" numeric(38, 18) NOT NULL
);
--> statement-breakpoint
DROP INDEX "uq_active_coin_owner";--> statement-breakpoint
ALTER TABLE "exchange_accounts" ADD COLUMN "replay_scope" text DEFAULT 'FORWARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "coin_ownership" ADD COLUMN "scope" text DEFAULT 'FORWARD' NOT NULL;--> statement-breakpoint
ALTER TABLE "recovery_gaps" ADD CONSTRAINT "recovery_gaps_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_instruments" ADD CONSTRAINT "replay_instruments_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD CONSTRAINT "replay_runs_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "replay_samples" ADD CONSTRAINT "replay_samples_run_id_replay_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."replay_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_coin_owner" ON "coin_ownership" USING btree ("scope","canonical_coin_key") WHERE "coin_ownership"."released_at" IS NULL;