ALTER TABLE "dispatches" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_dispatches" ADD COLUMN "cancelled_at" timestamp with time zone;