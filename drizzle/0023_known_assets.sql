CREATE TABLE "known_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"decimals" integer NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"added_by" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"enabled" boolean NOT NULL,
	CONSTRAINT "known_assets_decimals" CHECK ("known_assets"."decimals" BETWEEN 0 AND 255)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "known_assets_chain_address_idx" ON "known_assets" USING btree ("chain","address");--> statement-breakpoint
CREATE UNIQUE INDEX "known_assets_enabled_symbol_idx" ON "known_assets" USING btree ("chain",upper("symbol")) WHERE "known_assets"."enabled";--> statement-breakpoint
CREATE FUNCTION "known_assets_notify"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM pg_notify('known_assets', '');
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "known_assets_changed" AFTER INSERT OR UPDATE OR DELETE ON "known_assets" FOR EACH STATEMENT EXECUTE FUNCTION "known_assets_notify"();