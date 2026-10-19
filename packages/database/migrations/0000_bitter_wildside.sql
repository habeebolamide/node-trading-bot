CREATE TABLE "exchange_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"environment" text DEFAULT 'PAPER' NOT NULL,
	"equity_baseline" numeric(38, 18) DEFAULT '100' NOT NULL,
	"currency" text DEFAULT 'USDT' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exchange_accounts_owner_user_id_unique" UNIQUE("owner_user_id"),
	CONSTRAINT "account_paper_only" CHECK ("exchange_accounts"."environment" = 'PAPER'),
	CONSTRAINT "positive_baseline" CHECK ("exchange_accounts"."equity_baseline" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"bot_id" uuid,
	"actor_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"details" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange_account_id" uuid NOT NULL,
	"name" text NOT NULL,
	"canonical_market_id" text NOT NULL,
	"market" jsonb NOT NULL,
	"strategy_version_id" uuid NOT NULL,
	"execution_mode" text DEFAULT 'PAPER' NOT NULL,
	"risk_profile" text DEFAULT 'CONSERVATIVE' NOT NULL,
	"allocation_target_percent" numeric(9, 6) DEFAULT '0' NOT NULL,
	"operational_status" text DEFAULT 'STOPPED' NOT NULL,
	"trading_state" text DEFAULT 'IDLE' NOT NULL,
	"config_version" integer DEFAULT 1 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bot_account_identity" UNIQUE("id","exchange_account_id"),
	CONSTRAINT "bot_mode" CHECK ("bots"."execution_mode" IN ('PAPER','SIGNAL_ONLY')),
	CONSTRAINT "phase1_stopped" CHECK ("bots"."operational_status" = 'STOPPED' AND "bots"."trading_state" = 'IDLE'),
	CONSTRAINT "bot_risk_profile" CHECK ("bots"."risk_profile" IN ('CONSERVATIVE','MODERATE','AGGRESSIVE')),
	CONSTRAINT "allocation_bounds" CHECK ("bots"."allocation_target_percent" >= 0 AND "bots"."allocation_target_percent" <= 80),
	CONSTRAINT "signal_no_allocation" CHECK ("bots"."execution_mode" <> 'SIGNAL_ONLY' OR "bots"."allocation_target_percent" = 0),
	CONSTRAINT "positive_versions" CHECK ("bots"."config_version" > 0 AND "bots"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "bot_config_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"config_version" integer NOT NULL,
	"config_json" jsonb NOT NULL,
	"changed_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coin_ownership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"exchange_account_id" uuid NOT NULL,
	"canonical_coin_key" text NOT NULL,
	"bot_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "canonical_coin_format" CHECK ("coin_ownership"."canonical_coin_key" ~ '^[A-Z0-9]{2,15}$')
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "strategies_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "strategy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"strategy_id" uuid NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"requirements" jsonb NOT NULL,
	"code_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_status" CHECK ("strategy_versions"."status" IN ('DRAFT','VALIDATED'))
);
--> statement-breakpoint
CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"role" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_tokens_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "token_role" CHECK ("api_tokens"."role" IN ('OWNER','VIEWER'))
);
--> statement-breakpoint
CREATE TABLE "app_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "exchange_accounts" ADD CONSTRAINT "exchange_accounts_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_exchange_account_id_exchange_accounts_id_fk" FOREIGN KEY ("exchange_account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_strategy_version_id_strategy_versions_id_fk" FOREIGN KEY ("strategy_version_id") REFERENCES "public"."strategy_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_config_versions" ADD CONSTRAINT "bot_config_versions_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_config_versions" ADD CONSTRAINT "bot_config_versions_changed_by_app_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_ownership" ADD CONSTRAINT "coin_ownership_exchange_account_id_exchange_accounts_id_fk" FOREIGN KEY ("exchange_account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_ownership" ADD CONSTRAINT "coin_ownership_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coin_ownership" ADD CONSTRAINT "coin_ownership_bot_id_exchange_account_id_bots_id_exchange_account_id_fk" FOREIGN KEY ("bot_id","exchange_account_id") REFERENCES "public"."bots"("id","exchange_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_versions" ADD CONSTRAINT "strategy_versions_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_user_id_app_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "config_version_unique" ON "bot_config_versions" USING btree ("bot_id","config_version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_active_coin_owner" ON "coin_ownership" USING btree ("canonical_coin_key") WHERE "coin_ownership"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_coin_owner" ON "coin_ownership" USING btree ("bot_id") WHERE "coin_ownership"."released_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_version_unique" ON "strategy_versions" USING btree ("strategy_id","version");