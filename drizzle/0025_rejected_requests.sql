CREATE TABLE "rejected_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"status" integer NOT NULL,
	"chain" text,
	"idempotency_key" text,
	"token_kind" text NOT NULL,
	"code" text,
	"message" text NOT NULL,
	"chain_detail" jsonb,
	"body" jsonb
);
--> statement-breakpoint
CREATE INDEX "rejected_requests_at_id_idx" ON "rejected_requests" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "operator_actions_target_idx" ON "operator_actions" USING btree ("target_id");