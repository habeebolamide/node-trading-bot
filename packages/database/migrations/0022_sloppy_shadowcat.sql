CREATE TABLE "paper_funding_events" (
	"key" text PRIMARY KEY NOT NULL,
	"bot_id" uuid NOT NULL,
	"trade_id" uuid NOT NULL,
	"period" bigint NOT NULL,
	"rate" text NOT NULL,
	"price" numeric(38, 18) NOT NULL,
	"quantity" numeric(38, 18) NOT NULL,
	"amount" numeric(38, 18) NOT NULL,
	"observed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_funding_events" ADD CONSTRAINT "paper_funding_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_funding_events" ADD CONSTRAINT "paper_funding_events_trade_id_trade_lifecycles_id_fk" FOREIGN KEY ("trade_id") REFERENCES "public"."trade_lifecycles"("id") ON DELETE no action ON UPDATE no action;