import { DEFAULT_RPC_TIMEOUT_MS } from './rpc-timeout.js';

export const config = {
  port: Number(process.env.PORT ?? 8420),
  /** issue 15: per-call deadline for outbound RPC/Signer network calls (rpc-timeout.ts) — never how long broadcast()'s own confirmation polling loop may run in total. */
  rpcTimeoutMs: Number(process.env.RPC_TIMEOUT_MS ?? DEFAULT_RPC_TIMEOUT_MS),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://dispatch:dispatch@localhost:5432/dispatch',
  /** Base URL of the operator-configured Signer (ADR-0002) — swap this to point at a production Signer. */
  signerUrl: process.env.SIGNER_URL ?? 'http://localhost:8421',
  /** Comma-separated chain names (ADR-0019), e.g. "solana,evm" — parsed via chain-registry's parseEnabledChains. */
  enabledChains: process.env.ENABLED_CHAINS ?? '',
  /** Operator-configured shared secret (ADR-0022) — override in any non-dev deployment. */
  authToken: process.env.AUTH_TOKEN ?? 'dev-secret',
  /** Global Retry Policy default (ADR-0003) when a Dispatch request omits its own — off unless the operator opts in. */
  defaultRetryPolicy: process.env.DEFAULT_RETRY_POLICY === 'true',
  /** Solana Chain Handler config — only consulted when 'solana' is actually in enabledChains (ADR-0019). */
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
    /** The single Sender wallet (ADR-0016) this build's Solana Chain Handler transfers from. */
    senderAddress: process.env.SOLANA_SENDER_ADDRESS ?? '',
    /** Comma-separated `SYMBOL:mint:decimals` list — parsed via known-tokens.ts's parseSolanaKnownTokens. */
    knownTokens: process.env.SOLANA_KNOWN_TOKENS ?? '',
  },
};
