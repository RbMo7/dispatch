ALTER TABLE "dispatches" ADD COLUMN "retry_policy" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "broadcast_at" timestamp with time zone;