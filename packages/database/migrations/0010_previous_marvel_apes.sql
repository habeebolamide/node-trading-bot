CREATE TABLE IF NOT EXISTS "brain_token_memory" (
	"mint" text PRIMARY KEY NOT NULL,
	"domain" text DEFAULT 'memecoin' NOT NULL,
	"profile" jsonb NOT NULL,
	"score" numeric,
	"outcomes" jsonb,
	"evidence" text DEFAULT 'INSUFFICIENT' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "brain_wallet_memory" ADD COLUMN "behavior" jsonb;