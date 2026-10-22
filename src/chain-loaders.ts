import { Connection } from '@solana/web3.js';
import { createPublicClient, getAddress, http, isAddress } from 'viem';

import {
  BASE_ABANDONMENT_TIMEOUT_MS,
  BASE_REORG_RECHECK_WINDOW_MS,
  BaseChainHandler,
} from './chain-handler/base/base-chain-handler.js';
import { parseBaseKnownTokens } from './chain-handler/base/known-tokens.js';
import { SafeApproval } from './chain-handler/base/safe/safe-approval.js';
import { resolveBaseSafeConfig } from './chain-handler/base/safe/safe-config.js';
import { readSafeState } from './chain-handler/base/safe/safe-reads.js';
import { runSafeStartupChecks } from './chain-handler/base/safe/startup-checks.js';
import { SafeTxServiceClient } from './chain-handler/base/safe/tx-service-client.js';
import { readMultisigState } from './chain-handler/solana/multisig/multisig-account.js';
import {
  resolveSolanaMultisigConfig,
  type SolanaMultisigConfig,
} from './chain-handler/solana/multisig/multisig-config.js';
import { SquadsApproval } from './chain-handler/solana/multisig/squads-approval.js';
import { runMultisigStartupChecks } from './chain-handler/solana/multisig/startup-checks.js';
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
import { logger } from './logger.js';
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
    const connection = new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
      // issue 15: every RPC call this Connection makes is aborted, not
      // just abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
      fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
    });
    // #73 (ADR-0049): `single` is a no-op; `multisig` refuses to start before anything is sent.
    const multisig = await verifyMultisigSender(connection);
    const signerClient = new SignerClient(
      config.signerUrl,
      config.signerAuthToken,
      config.rpcTimeoutMs,
    );
    const knownTokens = parseSolanaKnownTokens(config.solana.knownTokens);
    const handler = new SolanaChainHandler({
      connection,
      signerClient,
      senderAddress: config.solana.senderAddress,
      knownTokens,
      // #74 (ADR-0054): a Multisig Sender proposes through Squads; `single` has no approval capability at all.
      ...(multisig
        ? {
            approval: new SquadsApproval({
              connection,
              signerClient,
              multisig,
              knownTokens,
              // An 'auto' price is not applied to a Proposal: it is not time-critical, and Approvers take hours.
              ...(typeof config.solana.computeUnitPriceMicroLamports === 'number'
                ? { computeUnitPriceMicroLamports: config.solana.computeUnitPriceMicroLamports }
                : {}),
            }),
          }
        : {}),
      computeUnitPriceMicroLamports: config.solana.computeUnitPriceMicroLamports,
      maxComputeUnitPriceMicroLamports: config.solana.maxComputeUnitPriceMicroLamports,
      maxConcurrentSends: config.solana.sendConcurrency,
    });
    // Mainnet review: a misconfigured or unpayable token stops startup, not one payment at a time.
    await handler.verifyKnownTokens();
    return handler;
  },
  base: async () => {
    // #82 (ADR-0051): `single` is a no-op; `safe` refuses to start before anything is sent.
    const safe = await verifySafeSender();
    const handler = await BaseChainHandler.create({
      rpcUrl: config.base.rpcUrl,
      chainId: config.base.chainId,
      senderAddress: config.base.senderAddress,
      signerClient: new SignerClient(config.signerUrl, config.signerAuthToken, config.rpcTimeoutMs),
      knownTokens: parseBaseKnownTokens(config.base.knownTokens),
      nonceHistoryStore: new PostgresNonceHistoryStore(db),
      feeBumpPercent: config.base.feeBumpPercent,
      bulkCallMaxBatchSize: config.base.bulkCallMaxBatchSize,
      ...(config.base.traceRpcUrl ? { traceRpcUrl: config.base.traceRpcUrl } : {}),
      // #83: in safe mode payments go out as Safe proposals; `single` has no approval capability at all.
      ...(safe ? { approval: safe.approval } : {}),
      // issue 15: every RPC call this client makes is aborted, not just
      // abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
      fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
    });
    // #84: the Safe's execute goes through this handler's own `prepare` (nonce authority, fees).
    safe?.bindHandler(handler);
    return handler;
  },
};

/** #73: Solana's Multisig Sender startup checks (solana/multisig/startup-checks.ts), wired to the real RPC and Signer. */
async function verifyMultisigSender(
  connection: Connection,
): Promise<SolanaMultisigConfig | undefined> {
  const multisig = resolveSolanaMultisigConfig(config.solana.multisig);
  if (multisig === undefined) return undefined;
  const { warnings } = await runMultisigStartupChecks({
    config: multisig,
    senderAddress: config.solana.senderAddress,
    readMultisig: (address) => readMultisigState(connection, address),
    readSignerPins: (member) =>
      new SignerClient(config.signerUrl, config.signerAuthToken, config.rpcTimeoutMs).readPins(
        member,
      ),
  });
  for (const warning of warnings) logger.warn(`Solana multisig sender: ${warning}`);
  logger.info(
    {
      multisig: multisig.multisigAddress,
      vault: multisig.vaultAddress,
      member: multisig.memberAddress,
    },
    'Solana multisig sender checks passed',
  );
  return multisig;
}

/** #82: Base's Safe Sender startup checks (safe/startup-checks.ts), wired to the real RPC, Safe Transaction Service and Signer. */
async function verifySafeSender(): Promise<
  { approval: SafeApproval; bindHandler: (handler: BaseChainHandler) => void } | undefined
> {
  const safe = resolveBaseSafeConfig(config.base.safe, config.base.chainId);
  if (safe === undefined) return undefined;
  const service = new SafeTxServiceClient({
    baseUrl: safe.txServiceUrl,
    apiKey: safe.apiKey,
    timeoutMs: config.rpcTimeoutMs,
  });
  const signerClient = new SignerClient(
    config.signerUrl,
    config.signerAuthToken,
    config.rpcTimeoutMs,
  );
  const readClient = createPublicClient({
    transport: http(config.base.rpcUrl, {
      fetchFn: fetchWithTimeout(fetch, config.rpcTimeoutMs),
    }),
  });
  const { warnings } = await runSafeStartupChecks({
    config: safe,
    chainId: config.base.chainId,
    service,
    readSafe: (address) => readSafeState(readClient, address),
    readSignerPins: (executor) => signerClient.readPins(executor),
  });
  for (const warning of warnings) logger.warn(`Safe sender: ${warning}`);
  logger.info(
    { safe: safe.safeAddress, executor: safe.executorAddress },
    'Safe sender checks passed',
  );
  // The handler is built after the approval (it takes the approval as a dependency), so `prepare` is bound late.
  let handler: BaseChainHandler | undefined;
  return {
    approval: new SafeApproval({
      config: safe,
      chainId: config.base.chainId,
      client: readClient,
      signer: signerClient,
      service,
      knownTokens: parseBaseKnownTokens(config.base.knownTokens),
      prepare: (items, sender) => {
        if (!handler) throw new Error('the Base handler is not ready to prepare a Safe execute');
        return handler.prepare(items, sender);
      },
    }),
    bindHandler: (built) => {
      handler = built;
    },
  };
}

/**
 * The Sender the Coordinator treats as paying on Base: the executor key in
 * `single` mode, the Safe in `safe` mode (ADR-0051), where the engine's own
 * key only proposes and executes. A malformed Safe address is left as typed:
 * the Base loader refuses to start on it, before anything is sent.
 */
function baseCoordinatorSender(): string {
  const { senderMode, safeAddress } = config.base.safe;
  const safe = safeAddress.trim();
  if (senderMode.trim() !== 'safe' || safe === '') return config.base.senderAddress;
  return isAddress(safe, { strict: false }) ? getAddress(safe) : safe;
}

const senderAddressByChain: Partial<Record<Chain, string>> = {
  solana: config.solana.senderAddress,
  base: baseCoordinatorSender(),
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
  if (config.signerAuthToken === undefined) {
    logger.warn(
      'SIGNER_AUTH_TOKEN is unset: the Signer will refuse every signing request with 401 (a Relay-only deployment can ignore this)',
    );
  }
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
  /** ADR-0053: per chain, how long a Proposal waits for approval. Only chains with a multisig Sender have an entry. */
  approvalDeadlineMsByChain: Map<Chain, number>;
  /** ADR-0053: per chain, how long a timed-out Proposal is still watched. Only chains with a multisig Sender have an entry. */
  approvalRewatchWindowMsByChain: Map<Chain, number>;
} {
  const senderAddresses = new Map<Chain, string>();
  const abandonmentTimeoutMs = new Map<Chain, number>();
  const reorgRecheckWindowMs = new Map<Chain, number>();
  const stuckHandling = new Map<Chain, StuckHandlingConfig>();
  const approvalDeadlineMsByChain = new Map<Chain, number>();
  const approvalRewatchWindowMsByChain = new Map<Chain, number>();

  const approvalConfigs: Partial<
    Record<Chain, { approvalDeadlineMs: number; approvalRewatchWindowMs: number } | undefined>
  > = {
    solana: resolveSolanaMultisigConfig(config.solana.multisig),
    base: resolveBaseSafeConfig(config.base.safe, config.base.chainId),
  };

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

    const approval = approvalConfigs[chain];
    if (approval !== undefined) {
      approvalDeadlineMsByChain.set(chain, approval.approvalDeadlineMs);
      approvalRewatchWindowMsByChain.set(chain, approval.approvalRewatchWindowMs);
    }
  }

  return {
    senderAddresses,
    abandonmentTimeoutMs,
    reorgRecheckWindowMs,
    stuckHandling,
    approvalDeadlineMsByChain,
    approvalRewatchWindowMsByChain,
  };
}
