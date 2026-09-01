CREATE TABLE IF NOT EXISTS "cluster_run" (
	"run_id" text PRIMARY KEY NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"window_hours" integer NOT NULL,
	"wallet_count" integer NOT NULL,
	"cluster_count" integer NOT NULL,
	"status" text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_cluster" (
	"id" text PRIMARY KEY NOT NULL,
	"cluster_id" text NOT NULL,
	"wallet_id" text NOT NULL,
	"cluster_run_id" text NOT NULL,
	"clustered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_funder" (
	"wallet_id" text PRIMARY KEY NOT NULL,
	"funder_address" text NOT NULL,
	"funded_at" timestamp with time zone NOT NULL,
	"funded_sol" numeric NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inferred_at_cap" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_cluster_run_cluster_idx" ON "wallet_cluster" USING btree ("cluster_run_id","cluster_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_cluster_wallet_run_idx" ON "wallet_cluster" USING btree ("wallet_id","cluster_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_funder_funder_idx" ON "wallet_funder" USING btree ("funder_address");