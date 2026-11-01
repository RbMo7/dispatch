CREATE TABLE "transaction_effects" (
	"chain" text NOT NULL,
	"hash" text NOT NULL,
	"effects" jsonb,
	"read_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "transaction_effects_chain_hash_pk" PRIMARY KEY("chain","hash")
);
--> statement-breakpoint
CREATE INDEX "transactions_confirmed_at_idx" ON "transactions" USING btree ("confirmed_at") WHERE "transactions"."status" = 'CONFIRMED';