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
  solana: () =>
    Promise.resolve(
      new SolanaChainHandler({
        connection: new Connection(config.solana.rpcUrl, {
          commitment: 'confirmed',
          // issue 15: every RPC call this Connection makes is aborted, not
          // just abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
          fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
        }),
        signerClient: new SignerClient(config.signerUrl, config.rpcTimeoutMs),
        senderAddress: config.solana.senderAddress,
        knownTokens: parseSolanaKnownTokens(config.solana.knownTokens),
      }),
    ),
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
} {
  const senderAddresses = new Map<Chain, string>();
  const abandonmentTimeoutMs = new Map<Chain, number>();
  const reorgRecheckWindowMs = new Map<Chain, number>();

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
  }

  return { senderAddresses, abandonmentTimeoutMs, reorgRecheckWindowMs };
}
