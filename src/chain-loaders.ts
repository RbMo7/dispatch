import { Connection } from '@solana/web3.js';

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
import { SignerClient } from './signer/client.js';

/**
 * The one place this build's real Chain Handler loaders — and the
 * per-chain config a Coordinator needs to actually drive them (ADR-0016's
 * single-Sender-per-chain address, ADR-0004's ABANDONED timeout) — are
 * registered together (ADR-0019). Shared by the API server (index.ts) and
 * the worker (worker.ts, issue 12) so both processes see the exact same
 * set of enabled chains and config: an EVM loader belongs here once EVM's
 * own Chain Handler feature exists, and naming 'evm' in ENABLED_CHAINS
 * before that fails loudly at startup (ChainRegistry.load), not silently,
 * for either process.
 */
const loaders: Partial<Record<'solana', ChainHandlerLoader>> = {
  solana: () =>
    Promise.resolve(
      new SolanaChainHandler({
        connection: new Connection(config.solana.rpcUrl, 'confirmed'),
        signerClient: new SignerClient(config.signerUrl),
        senderAddress: config.solana.senderAddress,
        knownTokens: parseSolanaKnownTokens(config.solana.knownTokens),
      }),
    ),
};

const senderAddressByChain: Partial<Record<Chain, string>> = {
  solana: config.solana.senderAddress,
};

const abandonmentTimeoutMsByChain: Partial<Record<Chain, number>> = {
  solana: SOLANA_ABANDONMENT_TIMEOUT_MS,
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
} {
  const senderAddresses = new Map<Chain, string>();
  const abandonmentTimeoutMs = new Map<Chain, number>();

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
  }

  return { senderAddresses, abandonmentTimeoutMs };
}
