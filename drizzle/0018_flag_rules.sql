CREATE TABLE "dispatch_holds" (
	"dispatch_id" uuid PRIMARY KEY NOT NULL,
	"matched" jsonb NOT NULL,
	"held_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flag_rule_versions" (
	"rule_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"name" text NOT NULL,
	"chain" text NOT NULL,
	"enabled" boolean NOT NULL,
	"definition" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "flag_rule_versions_rule_id_version_pk" PRIMARY KEY("rule_id","version")
);
--> statement-breakpoint
CREATE TABLE "flag_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"current_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "operator_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"target_id" uuid NOT NULL,
	"token_kind" text NOT NULL,
	"reason" text
);
--> statement-breakpoint
ALTER TABLE "dispatch_holds" ADD CONSTRAINT "dispatch_holds_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flag_rule_versions" ADD CONSTRAINT "flag_rule_versions_rule_id_flag_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."flag_rules"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_actions_at_id_idx" ON "operator_actions" USING btree ("at","id");