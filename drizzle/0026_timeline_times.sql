ALTER TABLE "dispatches" ADD COLUMN "first_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_dispatches" ADD COLUMN "first_claimed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
-- Rows from before #169: the best these columns can say is no later than anything the claim led to.
UPDATE "dispatches" d SET "first_claimed_at" = LEAST(
  d."claimed_at",
  (SELECT min(coalesce(t."broadcast_at", t."failed_at", t."confirmed_at")) FROM "transactions" t WHERE t."dispatch_id" = d."id")
) WHERE d."claimed_at" IS NOT NULL;--> statement-breakpoint
UPDATE "relay_dispatches" r SET "first_claimed_at" = LEAST(
  r."claimed_at",
  (SELECT min(coalesce(t."broadcast_at", t."failed_at", t."confirmed_at")) FROM "transactions" t WHERE t."dispatch_id" = r."id")
) WHERE r."claimed_at" IS NOT NULL;--> statement-breakpoint
UPDATE "transactions" t SET "sent_at" = LEAST(t."last_broadcast_at", coalesce(t."confirmed_at", t."last_broadcast_at"))
WHERE t."hash" IS NOT NULL
  AND t."last_broadcast_at" > t."broadcast_at"
  AND NOT EXISTS (SELECT 1 FROM "attempts" a WHERE a."transaction_id" = t."id");
