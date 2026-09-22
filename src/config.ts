export const config = {
  port: Number(process.env.PORT ?? 8420),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://dispatch:dispatch@localhost:5432/dispatch',
  /** Base URL of the operator-configured Signer (ADR-0002) — swap this to point at a production Signer. */
  signerUrl: process.env.SIGNER_URL ?? 'http://localhost:8421',
  /** Comma-separated chain names (ADR-0019), e.g. "solana,evm" — parsed via chain-registry's parseEnabledChains. */
  enabledChains: process.env.ENABLED_CHAINS ?? '',
  /** Operator-configured shared secret (ADR-0022) — override in any non-dev deployment. */
  authToken: process.env.AUTH_TOKEN ?? 'dev-secret',
  /** Global Retry Policy default (ADR-0003) when a Dispatch request omits its own — off unless the operator opts in. */
  defaultRetryPolicy: process.env.DEFAULT_RETRY_POLICY === 'true',
};
