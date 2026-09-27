import { Connection } from '@solana/web3.js';

import {
  BASE_ABANDONMENT_TIMEOUT_MS,
  BASE_REORG_RECHECK_WINDOW_MS,
  BaseChainHandler,
} from './chain-handler/base/base-chain-handler.js';
import { parseBaseKnownTokens } from './chain-handler/base/known-tokens.js';
import { parseSolanaKnownTokens } from './chain-handler/solana/known-tokens.js';
import {
  SOLANA_ABANDONMENT_TIMEOUT_MS,
  SolanaChainHandler,
} from './chain-handler/solana/solana-chain-handler.js';
import {
  ChainRegistry,
  parseEnabledChains,
  type ChainHandlerLoader,
} from './chain-registry/chain-registry.js';
import { config } from './config.js';
import type { StuckHandlingConfig } from './coordinator/coordinator.js';
import type { Chain } from './domain/chain.js';
import { PostgresNonceHistoryStore } from './repository/postgres-nonce-history-store.js';
import { db } from './db/client.js';
import { fetchWithTimeout } from './rpc-timeout.js';
import { SignerClient } from './signer/client.js';

/**
 * The one place this build's real Chain Handler loaders — and the
 * per-chain config a Coordinator needs to actually drive them (ADR-0016's
 * single-Sender-per-chain address, ADR-0004's ABANDONED timeout) — are
 * registered together (ADR-0019). Shared by the API server (index.ts) and
 * the worker (worker.ts, issue 12) so both processes see the exact same
 * set of enabled chains and config: naming an unregistered chain in
 * ENABLED_CHAINS fails loudly at startup (ChainRegistry.load), not
 * silently, for either process.
 */
const loaders: Partial<Record<Chain, ChainHandlerLoader>> = {
  solana: async () => {
    const handler = new SolanaChainHandler({
      connection: new Connection(config.solana.rpcUrl, {
        commitment: 'confirmed',
        // issue 15: every RPC call this Connection makes is aborted, not
        // just abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
        fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
      }),
      signerClient: new SignerClient(config.signerUrl, config.rpcTimeoutMs),
      senderAddress: config.solana.senderAddress,
      knownTokens: parseSolanaKnownTokens(config.solana.knownTokens),
      computeUnitPriceMicroLamports: config.solana.computeUnitPriceMicroLamports,
      maxComputeUnitPriceMicroLamports: config.solana.maxComputeUnitPriceMicroLamports,
      maxConcurrentSends: config.solana.sendConcurrency,
    });
    // Mainnet review: a misconfigured or unpayable token stops startup, not one payment at a time.
    await handler.verifyKnownTokens();
    return handler;
  },
  base: () =>
    BaseChainHandler.create({
      rpcUrl: config.base.rpcUrl,
      chainId: config.base.chainId,
      senderAddress: config.base.senderAddress,
      signerClient: new SignerClient(config.signerUrl, config.rpcTimeoutMs),
      knownTokens: parseBaseKnownTokens(config.base.knownTokens),
      nonceHistoryStore: new PostgresNonceHistoryStore(db),
      feeBumpPercent: config.base.feeBumpPercent,
      bulkCallMaxBatchSize: config.base.bulkCallMaxBatchSize,
      ...(config.base.traceRpcUrl ? { traceRpcUrl: config.base.traceRpcUrl } : {}),
      // issue 15: every RPC call this client makes is aborted, not just
      // abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
      fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
    }),
};

const senderAddressByChain: Partial<Record<Chain, string>> = {
  solana: config.solana.senderAddress,
  base: config.base.senderAddress,
};

const abandonmentTimeoutMsByChain: Partial<Record<Chain, number>> = {
  solana: SOLANA_ABANDONMENT_TIMEOUT_MS,
  base: BASE_ABANDONMENT_TIMEOUT_MS,
};

/**
 * issue 07: which chains opt into the reorg safety net's background
 * re-check, and for how long — a chain simply absent here (e.g. 'solana',
 * whose own commitment-level getStatus already covers this) is never
 * re-checked at all, unlike `abandonmentTimeoutMsByChain` above, which
 * every enabled chain must have an entry in.
 */
const reorgRecheckWindowMsByChain: Partial<Record<Chain, number>> = {
  base: BASE_REORG_RECHECK_WINDOW_MS,
};

/**
 * issue 07: the worker's reorg-recheck loop cadence. Lives here, beside the
 * windows it has to fit inside: a window no longer than one interval gets
 * roughly a single re-check, possibly before the block is even 'safe' —
 * the safety net would silently do nothing (ADR-0036). Checked at load.
 */
export const REORG_RECHECK_INTERVAL_MS = 60_000;
for (const [chain, windowMs] of Object.entries(reorgRecheckWindowMsByChain)) {
  if (windowMs < 3 * REORG_RECHECK_INTERVAL_MS) {
    throw new Error(
      `reorg recheck window for ${chain} (${windowMs}ms) must span at least 3 recheck intervals (${REORG_RECHECK_INTERVAL_MS}ms each)`,
    );
  }
}

/**
 * #9 (ADR-0037): which chains opt into stuck-transaction handling (fee-bump
 * or rebroadcast) — a chain absent here (e.g. 'solana', whose blockhash
 * expiry already resolves a stuck transaction, ADR-0030) is never touched.
 */
const stuckHandlingByChain: Partial<Record<Chain, StuckHandlingConfig>> = {
  base: { stuckAfterMs: config.base.stuckAfterMs, maxFeeBumps: config.base.maxFeeBumps },
};

export async function loadChainRegistry(): Promise<ChainRegistry> {
  return ChainRegistry.load(parseEnabledChains(config.enabledChains), loaders);
}

/**
 * The Coordinator's own per-chain config (ADR-0016/ADR-0004), for every
 * chain `registry` actually has a real Chain Handler for. Throws at
 * startup if an enabled chain is somehow missing either — a
 * configuration bug, never a business-relevant outcome (ADR-0010),
 * exactly like ChainRegistry.load's own "enabled but no loader" check.
 */
export function coordinatorConfigFor(registry: ChainRegistry): {
  senderAddresses: Map<Chain, string>;
  abandonmentTimeoutMs: Map<Chain, number>;
  reorgRecheckWindowMs: Map<Chain, number>;
  stuckHandling: Map<Chain, StuckHandlingConfig>;
} {
  const senderAddresses = new Map<Chain, string>();
  const abandonmentTimeoutMs = new Map<Chain, number>();
  const reorgRecheckWindowMs = new Map<Chain, number>();
  const stuckHandling = new Map<Chain, StuckHandlingConfig>();

  for (const chain of registry.handlers.keys()) {
    const senderAddress = senderAddressByChain[chain];
    const timeoutMs = abandonmentTimeoutMsByChain[chain];
    if (senderAddress === undefined || timeoutMs === undefined) {
      throw new Error(
        `Chain "${chain}" is enabled but this build has no worker-level sender address / ABANDONED timeout configured for it.`,
      );
    }
    senderAddresses.set(chain, senderAddress);
    abandonmentTimeoutMs.set(chain, timeoutMs);

    const recheckWindowMs = reorgRecheckWindowMsByChain[chain];
    if (recheckWindowMs !== undefined) reorgRecheckWindowMs.set(chain, recheckWindowMs);

    const stuckHandlingConfig = stuckHandlingByChain[chain];
    if (stuckHandlingConfig !== undefined) stuckHandling.set(chain, stuckHandlingConfig);
  }

  return { senderAddresses, abandonmentTimeoutMs, reorgRecheckWindowMs, stuckHandling };
}
