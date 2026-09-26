ALTER TABLE "dispatches" ADD COLUMN "claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_dispatches" ADD COLUMN "claimed_at" timestamp with time zone;