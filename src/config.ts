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
  /** Base Chain Handler config — only consulted when 'base' is actually in enabledChains (ADR-0019). Same shape as config.solana (base-chain-handler spec's own maintainer-facing decision). */
  base: {
    rpcUrl: process.env.BASE_RPC_URL ?? 'https://sepolia.base.org',
    /** Verified against the connected RPC's own eth_chainId at construction — refuses to start on mismatch. Base mainnet 8453, Base Sepolia 84532. */
    chainId: Number(process.env.BASE_CHAIN_ID ?? 84532),
    /** The single Sender wallet (ADR-0016) this build's Base Chain Handler transfers from. */
    senderAddress: process.env.BASE_SENDER_ADDRESS ?? '',
    /** Comma-separated `SYMBOL:contractAddress:decimals` list — parsed via known-tokens.ts's parseBaseKnownTokens. */
    knownTokens: process.env.BASE_KNOWN_TOKENS ?? '',
    /** Minimum percentage both maxFeePerGas and maxPriorityFeePerGas must be bumped by on a Retry Policy fee-bump replacement (issue 09) — go-ethereum/op-geth's own inherited PriceBump floor is 10%; a documented default with margin above that, not a verified Base-sequencer guarantee. */
    feeBumpPercent: Number(process.env.BASE_FEE_BUMP_PERCENT ?? 15),
    /** #9 (ADR-0037): how long a transaction may stay pending after its latest broadcast before it counts as stuck — fee-bumped (Retry Policy on) or else rebroadcast. */
    stuckAfterMs: Number(process.env.BASE_STUCK_AFTER_MS ?? 60_000),
    /** #9 (ADR-0037): the most fee-bump attempts (failed ones included) a Call gets before its latest version just waits out the ABANDONED timeout. */
    maxFeeBumps: Number(process.env.BASE_MAX_FEE_BUMPS ?? 5),
    /** Max items per Bulk Call transaction (issue 11) before the engine splits a request across multiple aggregate3Value transactions. */
    bulkCallMaxBatchSize: Number(process.env.BASE_BULK_CALL_MAX_BATCH_SIZE ?? 50),
  },
};
