CREATE TABLE "known_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"label" text NOT NULL,
	"definition" jsonb NOT NULL,
	"source" text NOT NULL,
	"added_by" text NOT NULL,
	"added_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"enabled" boolean NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "known_contracts_enabled_address_idx" ON "known_contracts" USING btree ("chain","address") WHERE "known_contracts"."enabled";--> statement-breakpoint
CREATE FUNCTION "known_contracts_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('known_contracts', '');
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "known_contracts_changed" AFTER INSERT OR UPDATE OR DELETE ON "known_contracts" FOR EACH STATEMENT EXECUTE FUNCTION "known_contracts_notify"();
