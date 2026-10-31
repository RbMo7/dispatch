CREATE TABLE "operator_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"target_id" uuid NOT NULL,
	"token_kind" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
CREATE INDEX "operator_actions_at_id_idx" ON "operator_actions" USING btree ("at","id");