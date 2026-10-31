CREATE TABLE "signer_keys" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"pins" jsonb,
	"error" text,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "signer_keys_chain_address_pk" PRIMARY KEY("chain","address"),
	CONSTRAINT "signer_keys_pins_or_error" CHECK (("signer_keys"."pins" IS NULL) <> ("signer_keys"."error" IS NULL))
);
