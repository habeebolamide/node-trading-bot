CREATE TABLE IF NOT EXISTS "watched_wallet" (
	"address" text PRIMARY KEY NOT NULL,
	"note" text,
	"watched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"unwatched_at" timestamp with time zone
);
