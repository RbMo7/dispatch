CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transaction_id" uuid NOT NULL,
	"broadcast_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" jsonb
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"items" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"call_index" integer NOT NULL,
	"chain" text NOT NULL,
	"signed_bytes" text NOT NULL,
	"hash" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"error" jsonb
);
--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_idempotency_key_idx" ON "dispatches" USING btree ("idempotency_key");