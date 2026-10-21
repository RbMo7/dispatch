CREATE TABLE "proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"chain" text NOT NULL,
	"sender_address" text NOT NULL,
	"chain_ref" jsonb NOT NULL,
	"payload" text NOT NULL,
	"proposal_ref" text NOT NULL,
	"sequence" bigint,
	"phase" text DEFAULT 'noted' NOT NULL,
	"approval_state" text DEFAULT 'awaiting' NOT NULL,
	"approvals" integer DEFAULT 0 NOT NULL,
	"threshold" integer NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"execute_after" timestamp with time zone,
	"timed_out_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"check_failures" integer DEFAULT 0 NOT NULL,
	"propose_signed_bytes" text,
	"propose_hash" text,
	"expected" jsonb NOT NULL,
	"committed" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "proposal_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "proposal_position" integer;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_proposal_ref_idx" ON "proposals" USING btree ("proposal_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_solana_sequence_idx" ON "proposals" USING btree ("chain","sender_address","sequence") WHERE "proposals"."chain" = 'solana';--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE no action ON UPDATE no action;