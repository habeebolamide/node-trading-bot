CREATE TABLE "paper_price_events" (
	"key" text PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_price_events" ADD CONSTRAINT "paper_price_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;