ALTER TABLE "dispatches" ADD COLUMN "sender_address" text;--> statement-breakpoint
CREATE INDEX "dispatches_chain_sender_status_idx" ON "dispatches" USING btree ("chain","sender_address","status");