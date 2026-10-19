CREATE TABLE "replay_experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"plan" jsonb NOT NULL,
	"variants" jsonb NOT NULL,
	"selected_variant" text,
	"selection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "experiment_id" uuid;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "stage" text DEFAULT 'EXPLORATORY' NOT NULL;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "variant" text;--> statement-breakpoint
ALTER TABLE "replay_runs" ADD COLUMN "window_index" integer;--> statement-breakpoint
ALTER TABLE "replay_experiments" ADD CONSTRAINT "replay_experiments_owner_user_id_app_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;