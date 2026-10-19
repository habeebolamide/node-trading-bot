CREATE TABLE "paper_equity_peaks" (
	"scope" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"peak" numeric(38, 18) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_equity_peaks" ADD CONSTRAINT "paper_equity_peaks_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;