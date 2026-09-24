CREATE TABLE "relay_dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"signed_transaction" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"transaction_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "relay_dispatches" ADD CONSTRAINT "relay_dispatches_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "relay_dispatches_idempotency_key_idx" ON "relay_dispatches" USING btree ("idempotency_key");