ALTER TABLE "transactions" ADD COLUMN "last_broadcast_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "replaces_transaction_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "fee_bump_attempts" integer DEFAULT 0 NOT NULL;