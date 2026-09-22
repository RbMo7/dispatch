ALTER TABLE "transactions" ALTER COLUMN "signed_bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ALTER COLUMN "hash" DROP NOT NULL;