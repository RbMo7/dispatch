export const config = {
  port: Number(process.env.PORT ?? 8420),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://dispatch:dispatch@localhost:5432/dispatch',
  /** Base URL of the operator-configured Signer (ADR-0002) — swap this to point at a production Signer. */
  signerUrl: process.env.SIGNER_URL ?? 'http://localhost:8421',
};
