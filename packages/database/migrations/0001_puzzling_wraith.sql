ALTER TABLE "wallet_transaction" ALTER COLUMN "amount_usd" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "amount_sol" numeric DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_transaction" ADD COLUMN "token_amount" numeric DEFAULT '0' NOT NULL;