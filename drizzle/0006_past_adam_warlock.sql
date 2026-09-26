CREATE TABLE "nonce_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"sender_address" text NOT NULL,
	"nonce" integer NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "nonce_history_chain_sender_nonce_idx" ON "nonce_history" USING btree ("chain","sender_address","nonce");