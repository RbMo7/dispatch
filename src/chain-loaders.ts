import { Connection } from '@solana/web3.js';
import { createPublicClient, http, type Address, type PublicClient } from 'viem';

import {
  BASE_ABANDONMENT_TIMEOUT_MS,
  BASE_REORG_RECHECK_WINDOW_MS,
  BaseChainHandler,
} from './chain-handler/base/base-chain-handler.js';
import { SafeApproval } from './chain-handler/base/safe/safe-approval.js';
import {
  resolveBaseSafeConfig,
  type BaseSafeConfig,
} from './chain-handler/base/safe/safe-config.js';
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
import {
  SOLANA_ABANDONMENT_TIMEOUT_MS,
  SolanaChainHandler,
} from './chain-handler/solana/solana-chain-handler.js';
import {
  ChainRegistry,
  parseEnabledChains,
  type RegisteredSender,
} from './chain-registry/chain-registry.js';
import { config } from './config.js';
import type { CoordinatorSender, StuckHandlingConfig } from './coordinator/coordinator.js';
import type { Chain } from './domain/chain.js';
import type { SenderAddress } from './domain/sender.js';
import { PostgresNonceHistoryStore } from './repository/postgres-nonce-history-store.js';
import { db, queryClient } from './db/client.js';
import { logger } from './logger.js';
import { fetchWithTimeout } from './rpc-timeout.js';
import { SignerClient } from './signer/client.js';
import { AssetRegistry } from './asset-registry/asset-registry.js';
import { configuredAssets } from './asset-registry/configured-assets.js';
import { KNOWN_ASSETS_CHANNEL, watchKnownAssets } from './asset-registry/watch.js';
import type { ReadToken } from './chain-handler/chain-handler.js';
import { readBaseToken } from './chain-handler/base/token-reads.js';
import { readSolanaToken } from './chain-handler/solana/token-reads.js';
import { baseNetwork, solanaNetwork, type Network } from './api/network.js';
import type { SenderConfig, SenderReads } from './api/senders.js';
import type { DispatchError } from './domain/errors.js';
import { err, ok, type Result } from './domain/result.js';
import type { DispatchStore } from './repository/dispatch-store.js';
import {
  baseSenderAddress,
  parseSendersConfig,
  readSendersSource,
  solanaSenderAddress,
  type BaseSenderSpec,
  type ChainSendersSpec,
  type SendersConfig,
  type SolanaSenderSpec,
} from './senders-config.js';

const NO_SIGNER: DispatchError = {
  code: 'SIGNER_UNREACHABLE',
  message: 'the API process has no Signer; only the worker signs (ADR-0059)',
};

/**
 * ADR-0059: what the API's handlers hold in place of a Signer. The API plans
 * Proposals but never signs, and holds no Signer URL or token.
 */
const noSigner: Pick<SignerClient, 'requestSignature' | 'signSafeTransaction'> = {
  requestSignature: () => Promise.resolve(err(NO_SIGNER)),
  signSafeTransaction: () => Promise.resolve(err(NO_SIGNER)),
};

/** ADR-0060: the senders file, or today's variables, for every enabled chain. Its warnings are logged here. */
export function loadSendersConfig(): SendersConfig {
  const senders = parseSendersConfig({
    source: readSendersSource(config.sendersFile),
    enabledChains: parseEnabledChains(config.enabledChains),
    variables: { solana: config.solana.multisig, base: config.base.safe },
  });
  for (const warning of senders.warnings) logger.warn(warning);
  return senders;
}

type ChainSendersLoader = (
  chain: ChainSendersSpec,
  assets: AssetRegistry,
  signer: SignerClient | undefined,
  named: <T>(name: string, build: () => Promise<T>) => Promise<T>,
) => Promise<RegisteredSender[]>;

/** Today's message for an enabled chain whose variables name no Sender. */
function noSenderAddress(chain: Chain): Error {
  return new Error(
    `Chain "${chain}" is enabled but has no Sender address: set ${chain.toUpperCase()}_SENDER_ADDRESS, or the multisig settings that imply it.`,
  );
}

/**
 * The one place this build's real Chain Handler loaders are registered
 * (ADR-0019). Shared by the API server (index.ts) and the worker (worker.ts,
 * issue 12) so both processes see the exact same Senders and config. ADR-0060:
 * each chain builds one RPC client and, on it, one handler per Sender, each
 * after its own startup checks (ADR-0049, ADR-0051, ADR-0055).
 */
const chainLoaders: Record<Chain, ChainSendersLoader> = {
  solana: async ({ chain, default: defaultName, senders }, assets, signer, named) => {
    const connection = new Connection(config.solana.rpcUrl, {
      commitment: 'confirmed',
      // issue 15: every RPC call this Connection makes is aborted, not
      // just abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
      fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
    });
    const solanaAssets = assets.forChain('solana');
    const registered: RegisteredSender[] = [];
    for (const spec of senders as SolanaSenderSpec[]) {
      registered.push(
        await named(spec.name, async () => {
          // #73 (ADR-0049): `single` is a no-op; `multisig` refuses to start before anything is sent.
          const multisig = await verifyMultisigSender(connection, signer, spec);
          if (!spec.address) throw noSenderAddress(chain);
          const handler = new SolanaChainHandler({
            connection,
            ...(signer ? { signerClient: signer } : {}),
            senderAddress: spec.address,
            assets: solanaAssets,
            // #74 (ADR-0054): a Multisig Sender proposes through Squads; `single` has no approval capability at all.
            ...(multisig
              ? {
                  approval: new SquadsApproval({
                    connection,
                    signerClient: signer ?? noSigner,
                    multisig,
                    assets: solanaAssets,
                    // An 'auto' price is not applied to a Proposal: it is not time-critical, and Approvers take hours.
                    ...(typeof config.solana.computeUnitPriceMicroLamports === 'number'
                      ? {
                          computeUnitPriceMicroLamports:
                            config.solana.computeUnitPriceMicroLamports,
                        }
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
          return {
            chain,
            name: spec.name,
            address: spec.address as SenderAddress,
            isDefault: spec.name === defaultName,
            handler,
            ...(multisig
              ? {
                  multisig: {
                    address: multisig.multisigAddress,
                    approvalDeadlineMs: multisig.approvalDeadlineMs,
                    approvalRewatchWindowMs: multisig.approvalRewatchWindowMs,
                  },
                  approverLabels: spec.approverLabels,
                }
              : {}),
          };
        }),
      );
    }
    return registered;
  },
  base: async ({ chain, default: defaultName, senders }, assets, signer, named) => {
    const fetchFn = fetchWithTimeout(fetch, config.rpcTimeoutMs);
    // issue 15: every RPC call this client makes is aborted, not just
    // abandoned, past config.rpcTimeoutMs — see rpc-timeout.ts.
    const client = createPublicClient({ transport: http(config.base.rpcUrl, { fetchFn }) });
    const nonceHistoryStore = new PostgresNonceHistoryStore(db);
    const registered: RegisteredSender[] = [];
    for (const spec of senders as BaseSenderSpec[]) {
      registered.push(
        await named(spec.name, async () => {
          // #82 (ADR-0051): `single` is a no-op; `safe` refuses to start before anything is sent.
          const safe = await verifySafeSender(signer, spec, client, assets);
          const handler = await BaseChainHandler.create({
            rpcUrl: config.base.rpcUrl,
            client,
            chainId: config.base.chainId,
            senderAddress: spec.handlerAddress,
            ...(signer ? { signerClient: signer } : {}),
            assets: assets.forChain('base'),
            nonceHistoryStore,
            feeBumpPercent: config.base.feeBumpPercent,
            bulkCallMaxBatchSize: config.base.bulkCallMaxBatchSize,
            ...(config.base.traceRpcUrl ? { traceRpcUrl: config.base.traceRpcUrl } : {}),
            // #83: in safe mode payments go out as Safe proposals; `single` has no approval capability at all.
            ...(safe ? { approval: safe.approval } : {}),
            fetch: fetchFn,
          });
          // #84: the Safe's execute goes through this handler's own `prepare` (nonce authority, fees).
          safe?.bindHandler(handler);
          if (!spec.address) throw noSenderAddress(chain);
          return {
            chain,
            name: spec.name,
            address: spec.address as SenderAddress,
            isDefault: spec.name === defaultName,
            handler,
            ...(safe
              ? {
                  multisig: {
                    address: safe.config.safeAddress,
                    approvalDeadlineMs: safe.config.approvalDeadlineMs,
                    approvalRewatchWindowMs: safe.config.approvalRewatchWindowMs,
                  },
                  approverLabels: spec.approverLabels,
                }
              : {}),
          };
        }),
      );
    }
    return registered;
  },
};

/** #73: Solana's Multisig Sender startup checks (solana/multisig/startup-checks.ts), wired to the real RPC and, in the worker, the Signer. */
async function verifyMultisigSender(
  connection: Connection,
  signer: SignerClient | undefined,
  spec: SolanaSenderSpec,
): Promise<SolanaMultisigConfig | undefined> {
  const multisig = resolveSolanaMultisigConfig(spec.settings);
  if (multisig === undefined) return undefined;
  const { warnings } = await runMultisigStartupChecks({
    config: multisig,
    senderAddress: spec.address,
    readMultisig: (address) => readMultisigState(connection, address),
    ...(signer ? { readSignerPins: (member: string) => signer.readPins(member) } : {}),
  });
  for (const warning of warnings) logger.warn(`Solana multisig sender ${spec.name}: ${warning}`);
  logger.info(
    {
      sender: spec.name,
      multisig: multisig.multisigAddress,
      vault: multisig.vaultAddress,
      member: multisig.memberAddress,
    },
    'Solana multisig sender checks passed',
  );
  return multisig;
}

/** #82: Base's Safe Sender startup checks (safe/startup-checks.ts), wired to the real RPC, Safe Transaction Service and, in the worker, the Signer. */
async function verifySafeSender(
  signer: SignerClient | undefined,
  spec: BaseSenderSpec,
  readClient: PublicClient,
  assets: AssetRegistry,
): Promise<
  | {
      config: BaseSafeConfig;
      approval: SafeApproval;
      bindHandler: (handler: BaseChainHandler) => void;
    }
  | undefined
> {
  const safe = resolveBaseSafeConfig(spec.settings, config.base.chainId);
  if (safe === undefined) return undefined;
  const service = new SafeTxServiceClient({
    baseUrl: safe.txServiceUrl,
    apiKey: safe.apiKey,
    timeoutMs: config.rpcTimeoutMs,
  });
  const { warnings } = await runSafeStartupChecks({
    config: safe,
    chainId: config.base.chainId,
    service,
    readSafe: (address) => readSafeState(readClient, address),
    ...(signer ? { readSignerPins: (executor: Address) => signer.readPins(executor) } : {}),
  });
  for (const warning of warnings) logger.warn(`Safe sender ${spec.name}: ${warning}`);
  logger.info(
    { sender: spec.name, safe: safe.safeAddress, executor: safe.executorAddress },
    'Safe sender checks passed',
  );
  // The handler is built after the approval (it takes the approval as a dependency), so `prepare` is bound late.
  let handler: BaseChainHandler | undefined;
  return {
    config: safe,
    approval: new SafeApproval({
      config: safe,
      chainId: config.base.chainId,
      client: readClient,
      signer: signer ?? noSigner,
      service,
      assets: assets.forChain('base'),
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

/** Today's variables' Sender per chain: what a registry built from bare handlers (ChainRegistry.load) pays from. */
const variablesSenderAddress: Record<Chain, () => string> = {
  solana: () => solanaSenderAddress(config.solana.multisig),
  base: () => baseSenderAddress(config.base.safe),
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

/**
 * ADR-0061: seeds the config rows, reads the registry, and keeps it in step
 * with every later change. The API and the worker each call it once.
 */
export async function loadAssetRegistry(store: DispatchStore): Promise<AssetRegistry> {
  const seeded = await store.seedConfigAssets(
    configuredAssets({ solana: config.solana.knownTokens, base: config.base.knownTokens }),
  );
  if (!seeded.ok) throw new Error(seeded.error);
  const registry = new AssetRegistry(() => store.listKnownAssets());
  await registry.refresh();
  await watchKnownAssets(registry, {
    listen: (onChange) => queryClient.listen(KNOWN_ASSETS_CHANNEL, onChange, onChange),
    logger,
  });
  return registry;
}

/** ADR-0061: each enabled chain's own token reads, for adding a Known Asset. */
export function tokenReadersFor(registry: ChainRegistry): Partial<Record<Chain, ReadToken>> {
  const fetchFn = fetchWithTimeout(fetch, config.rpcTimeoutMs);
  const readers: Record<Chain, () => ReadToken> = {
    solana: () => {
      const connection = new Connection(config.solana.rpcUrl, {
        commitment: 'confirmed',
        fetch: fetchFn,
      });
      return (address) => readSolanaToken(connection, address);
    },
    base: () => {
      const client = createPublicClient({ transport: http(config.base.rpcUrl, { fetchFn }) });
      return (address) => readBaseToken(client, address);
    },
  };
  return Object.fromEntries(
    [...registry.handlers.keys()].map((chain) => [chain, readers[chain]()]),
  );
}

/** `signer` is the worker's; the API passes none (ADR-0059), so its Multisig startup checks skip the Signer. */
export async function loadChainRegistry(
  assets: AssetRegistry,
  signer?: SignerClient,
): Promise<ChainRegistry> {
  const senders = loadSendersConfig();
  const registered: RegisteredSender[] = [];
  for (const chain of senders.chains) {
    // A file names several Senders, so a startup error says which one; today's variables keep today's messages.
    const named = async <T>(name: string, build: () => Promise<T>): Promise<T> => {
      if (senders.source === 'variables') return build();
      try {
        return await build();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`${chain.chain} sender "${name}": ${message}`, { cause });
      }
    };
    registered.push(...(await chainLoaders[chain.chain](chain, assets, signer, named)));
  }
  return ChainRegistry.fromSenders(registered);
}

/** ADR-0059: only the worker reaches the Signer. */
export function workerSignerClient(): SignerClient {
  if (config.signerAuthToken === undefined) {
    logger.warn(
      'SIGNER_AUTH_TOKEN is unset: the Signer will refuse every signing request with 401 (a Relay-only deployment can ignore this)',
    );
  }
  return new SignerClient(config.signerUrl, config.signerAuthToken, config.rpcTimeoutMs);
}

/** ADR-0059: the key each Sender signs with, whose pins the worker records: the Sender, or a Multisig Sender's engine key. */
export function signerKeysFor(registry: ChainRegistry): { chain: Chain; address: string }[] {
  return registry.senders.flatMap((sender) => {
    const address =
      sender.handler.approval?.proposerAddress ??
      sender.address ??
      variablesSenderAddress[sender.chain]();
    return address ? [{ chain: sender.chain, address }] : [];
  });
}

/**
 * The Coordinator's own per-chain config (ADR-0004), for every chain
 * `registry` actually has a real Chain Handler for, and (ADR-0060) every
 * Sender with its approval timings. `senderAddresses` and the `…ByChain`
 * approval maps are the single-Sender shape: each chain's default Sender.
 * Throws at startup if an enabled chain is somehow missing its ABANDONED
 * timeout — a configuration bug, never a business-relevant outcome (ADR-0010).
 */
export function coordinatorConfigFor(registry: ChainRegistry): {
  senders: CoordinatorSender[];
  senderAddresses: Map<Chain, string>;
  abandonmentTimeoutMs: Map<Chain, number>;
  reorgRecheckWindowMs: Map<Chain, number>;
  stuckHandling: Map<Chain, StuckHandlingConfig>;
  /** ADR-0053: per chain, how long its default Sender's Proposal waits for approval. Only chains whose default is a Multisig Sender have an entry. */
  approvalDeadlineMsByChain: Map<Chain, number>;
  /** ADR-0053: per chain, how long its default Sender's timed-out Proposal is still watched. */
  approvalRewatchWindowMsByChain: Map<Chain, number>;
} {
  const senders: CoordinatorSender[] = registry.senders.map((sender) => {
    const address = sender.address ?? variablesSenderAddress[sender.chain]();
    if (!address) throw noSenderAddress(sender.chain);
    return {
      ref: { chain: sender.chain, address: address as SenderAddress },
      handler: sender.handler,
      isDefault: sender.isDefault,
      approvalDeadlineMs: sender.multisig?.approvalDeadlineMs,
      approvalRewatchWindowMs: sender.multisig?.approvalRewatchWindowMs,
    };
  });
  const senderAddresses = new Map<Chain, string>();
  const abandonmentTimeoutMs = new Map<Chain, number>();
  const reorgRecheckWindowMs = new Map<Chain, number>();
  const stuckHandling = new Map<Chain, StuckHandlingConfig>();
  const approvalDeadlineMsByChain = new Map<Chain, number>();
  const approvalRewatchWindowMsByChain = new Map<Chain, number>();

  for (const sender of senders.filter((s) => s.isDefault)) {
    senderAddresses.set(sender.ref.chain, sender.ref.address);
    if (sender.approvalDeadlineMs !== undefined) {
      approvalDeadlineMsByChain.set(sender.ref.chain, sender.approvalDeadlineMs);
    }
    if (sender.approvalRewatchWindowMs !== undefined) {
      approvalRewatchWindowMsByChain.set(sender.ref.chain, sender.approvalRewatchWindowMs);
    }
  }

  for (const chain of registry.handlers.keys()) {
    const timeoutMs = abandonmentTimeoutMsByChain[chain];
    if (timeoutMs === undefined) {
      throw new Error(
        `Chain "${chain}" is enabled but this build has no worker-level ABANDONED timeout configured for it.`,
      );
    }
    abandonmentTimeoutMs.set(chain, timeoutMs);

    const recheckWindowMs = reorgRecheckWindowMsByChain[chain];
    if (recheckWindowMs !== undefined) reorgRecheckWindowMs.set(chain, recheckWindowMs);

    const stuckHandlingConfig = stuckHandlingByChain[chain];
    if (stuckHandlingConfig !== undefined) stuckHandling.set(chain, stuckHandlingConfig);
  }

  return {
    senders,
    senderAddresses,
    abandonmentTimeoutMs,
    reorgRecheckWindowMs,
    stuckHandling,
    approvalDeadlineMsByChain,
    approvalRewatchWindowMsByChain,
  };
}

async function readSolanaNetwork(): Promise<Network> {
  const connection = new Connection(config.solana.rpcUrl, {
    fetch: fetchWithTimeout(fetch, config.rpcTimeoutMs),
  });
  try {
    return solanaNetwork(await connection.getGenesisHash());
  } catch (cause) {
    logger.warn({ err: cause }, 'senders: Solana genesis hash read failed; network is unknown');
    return 'unknown';
  }
}

export async function senderConfigsFor(
  registry: ChainRegistry,
  assets: AssetRegistry,
): Promise<SenderConfig[]> {
  const { senders } = coordinatorConfigFor(registry);
  const readNetwork: Record<Chain, () => Promise<Network>> = {
    base: () => Promise.resolve(baseNetwork(config.base.chainId)),
    solana: readSolanaNetwork,
  };
  const networks = new Map(
    await Promise.all(
      [...registry.handlers.keys()].map(
        async (chain) => [chain, await readNetwork[chain]()] as const,
      ),
    ),
  );
  // A registry built from bare handlers knows no multisig: today's variables describe it.
  const variablesMultisig: Record<Chain, () => string | undefined> = {
    solana: () => resolveSolanaMultisigConfig(config.solana.multisig)?.multisigAddress,
    base: () => resolveBaseSafeConfig(config.base.safe, config.base.chainId)?.safeAddress,
  };
  // ADR-0060: one entry per Sender, in configuration order.
  return registry.senders.map((sender, index): SenderConfig => {
    const { chain, handler } = sender;
    const { address } = (senders[index] as CoordinatorSender).ref;
    const approval = handler.approval;
    return {
      chain,
      name: sender.name,
      isDefault: sender.isDefault,
      network: networks.get(chain) ?? 'unknown',
      address,
      assets,
      ...(approval
        ? {
            approval: {
              mode: approval.holders.sender === 'vault' ? ('squads' as const) : ('safe' as const),
              multisigAddress: sender.multisig?.address ?? variablesMultisig[chain]() ?? address,
              engineKey: approval.proposerAddress,
              holders: approval.holders,
              rewatchWindowMs: sender.multisig?.approvalRewatchWindowMs ?? 0,
            },
          }
        : {}),
    };
  });
}

export function senderReadsFor(registry: ChainRegistry, store: DispatchStore): SenderReads {
  const fetchFn = fetchWithTimeout(fetch, config.rpcTimeoutMs);
  const unavailable = (chain: Chain, cause: unknown): Result<number, DispatchError> => {
    logger.warn({ chain, err: cause }, 'senders: multisig threshold read failed');
    return err({ code: 'RPC_UNAVAILABLE', message: 'multisig threshold read failed' });
  };
  // ADR-0060: each Multisig Sender's own multisig; without one named, today's variables'.
  const thresholdReaders: Partial<
    Record<Chain, (multisig: string | undefined) => Promise<number>>
  > = {
    solana: async (named) => {
      const multisig =
        named ?? resolveSolanaMultisigConfig(config.solana.multisig)?.multisigAddress;
      if (!multisig) throw new Error('not a multisig Sender');
      const connection = new Connection(config.solana.rpcUrl, {
        commitment: 'confirmed',
        fetch: fetchFn,
      });
      const state = await readMultisigState(connection, multisig);
      const account = state.account?.multisig;
      if (!account || 'undecodable' in account) throw new Error('multisig account unreadable');
      return account.threshold;
    },
    base: async (named) => {
      const safe =
        named ?? resolveBaseSafeConfig(config.base.safe, config.base.chainId)?.safeAddress;
      if (!safe) throw new Error('not a Safe Sender');
      const client = createPublicClient({ transport: http(config.base.rpcUrl, { fetchFn }) });
      return (await readSafeState(client, safe as Address)).threshold;
    },
  };
  return {
    getBalance: async (chain, address, asset) => {
      const handler = registry.get(chain);
      if (!handler.ok) return handler;
      const balance = await handler.value.getBalance(address, asset);
      if (!balance.ok)
        logger.warn({ chain, asset, error: balance.error }, 'senders: balance read failed');
      return balance;
    },
    getSignerKey: (chain, address) => store.getSignerKey(chain, address),
    readThreshold: async (chain, multisigAddress) => {
      const reader = thresholdReaders[chain];
      if (!reader) return unavailable(chain, new Error('no threshold reader'));
      try {
        return ok(await reader(multisigAddress));
      } catch (cause) {
        return unavailable(chain, cause);
      }
    },
    listCommitted: (chain, holder, timedOutSince, senderAddress) =>
      store.listCommitted(chain, holder, timedOutSince, senderAddress),
    foreignActivity: (chain, address, since) => store.foreignActivity({ chain, address }, since),
    now: () => new Date(),
  };
}
