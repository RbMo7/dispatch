CREATE TABLE "setup_checks" (
	"id" text PRIMARY KEY NOT NULL,
	"area" text NOT NULL,
	"title" text NOT NULL,
	"chain" text,
	"status" text NOT NULL,
	"finding" text NOT NULL,
	"fix" jsonb,
	"ran_at" timestamp with time zone NOT NULL,
	CONSTRAINT "setup_checks_fix_unless_pass" CHECK (("setup_checks"."status" = 'pass') = ("setup_checks"."fix" IS NULL))
);
