ALTER TABLE "trading_agent" ADD COLUMN "lifecycle_state" text DEFAULT 'IDLE' NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_agent" ADD COLUMN "lifecycle_until" timestamp with time zone;