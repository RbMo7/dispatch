CREATE TABLE "sender_foreign_nonces" (
	"chain" text NOT NULL,
	"sender_address" text NOT NULL,
	"nonce" integer NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sender_foreign_nonces_chain_sender_address_nonce_pk" PRIMARY KEY("chain","sender_address","nonce")
);
--> statement-breakpoint
CREATE INDEX "sender_foreign_nonces_seen_idx" ON "sender_foreign_nonces" USING btree ("chain","sender_address","first_seen_at");