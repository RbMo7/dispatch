import type { Balance } from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { AssetRegistry } from '../asset-registry/asset-registry.js';
import type { Network } from './network.js';
import type { DispatchError } from '../domain/errors.js';
import type { AssetAmount } from '../domain/proposal.js';
import type { Result } from '../domain/result.js';
import type { CommittedHolder, SignerKeyRecord } from '../repository/dispatch-store.js';
import type { SignerPins } from '../signer/client.js';

/**
 * #111: what one enabled chain's Sender is, from config. Its balances are
 * read in every payable asset of `assets` (ADR-0061), the native coin first.
 * `approval` is present exactly for a Multisig Sender (ADR-0049).
 */
export type SenderConfig = {
  chain: Chain;
  /** ADR-0060: the configured name, and whether a Dispatch that names no Sender pays from it. */
  name?: string;
  isDefault?: boolean;
  network: Network;
  /** What pays the payments: the plain key, the Squads vault, or the Safe. */
  address: string;
  assets: Pick<AssetRegistry, 'payableSymbols' | 'decimalsOf'>;
  approval?: {
    mode: 'squads' | 'safe';
    /** The Squads multisig account, or the Safe (then the same as `address`). */
    multisigAddress: string;
    /** The engine's own key: the Squads member, or the Safe executor. Pays the network cost. */
    engineKey: string;
    /** What the Funding Check calls each balance (`chainDetail.holder`). */
    holders: { sender: 'vault' | 'safe'; proposer: 'memberKey' | 'executor' };
    /** ADR-0053: how long a timed-out Proposal still holds funds back. */
    rewatchWindowMs: number;
  };
};

export type SenderReads = {
  getBalance(chain: Chain, address: string, asset: string): Promise<Result<Balance, DispatchError>>;
  getSignerKey(chain: Chain, address: string): Promise<SignerKeyRecord | null>;
  /** ADR-0060: the threshold of `multisigAddress`, the Sender's own multisig. */
  readThreshold(chain: Chain, multisigAddress?: string): Promise<Result<number, DispatchError>>;
  /** ADR-0060: what `senderAddress`'s own Proposals and Calls hold back. */
  listCommitted(
    chain: Chain,
    holder: CommittedHolder,
    timedOutSince: Date,
    senderAddress?: string,
  ): Promise<AssetAmount[]>;
  now(): Date;
};

/** A field whose external read failed. Only the reason's kind: an RPC or Signer message can carry a URL with a key in it. */
export type FieldError = { error: string };

export type HolderBalances = {
  /** `sender` for a plain Sender; otherwise the Funding Check's own name for the balance. */
  holder: 'sender' | 'vault' | 'safe' | 'memberKey' | 'executor';
  address: string;
  /** `committed` is what the Funding Check subtracts from `balance` before paying (ADR-0053, ADR-0054). */
  assets: {
    asset: string;
    /** Absent when the asset is not configured. */
    decimals?: number;
    balance: string | FieldError;
    committed: string;
  }[];
};

export type SenderView = {
  chain: Chain;
  name?: string;
  default?: boolean;
  network: Network;
  mode: 'single' | 'squads' | 'safe';
  address: string;
  multisig: {
    address: string;
    threshold: number | FieldError;
    engineKey: string;
  } | null;
  balances: HolderBalances[];
  /** ADR-0055: what the Signer says the engine's signing key is pinned to, as the worker last read it (ADR-0059). */
  signerKey: ((SignerPins | FieldError) & { readAt: string }) | { status: 'not_read_yet' };
};

function signerKeyView(record: SignerKeyRecord | null): SenderView['signerKey'] {
  if (!record) return { status: 'not_read_yet' };
  const read = 'pins' in record.read ? record.read.pins : record.read;
  return { ...read, readAt: record.readAt.toISOString() };
}

export async function readSender(config: SenderConfig, reads: SenderReads): Promise<SenderView> {
  const { chain, approval } = config;
  const timedOutSince = new Date(reads.now().getTime() - (approval?.rewatchWindowMs ?? 0));
  const holderBalances = async (
    holder: HolderBalances['holder'],
    committedHolder: CommittedHolder,
    address: string,
    assets: readonly string[],
  ): Promise<HolderBalances> => {
    const committed = await reads.listCommitted(
      chain,
      committedHolder,
      timedOutSince,
      config.address,
    );
    return {
      holder,
      address,
      assets: await Promise.all(
        assets.map(async (asset) => {
          const balance = await reads.getBalance(chain, address, asset);
          const decimals = config.assets.decimalsOf(chain, asset);
          return {
            asset,
            ...(decimals === undefined ? {} : { decimals }),
            balance: balance.ok ? balance.value.amount : { error: balance.error.code },
            committed: committed.find((c) => c.asset === asset)?.amount ?? '0',
          };
        }),
      ),
    };
  };
  const assets = config.assets.payableSymbols(chain);
  const signingKey = approval?.engineKey ?? config.address;
  const [balances, signerKey, threshold] = await Promise.all([
    Promise.all(
      approval
        ? [
            holderBalances(approval.holders.sender, 'sender', config.address, assets),
            holderBalances(
              approval.holders.proposer,
              'proposer',
              approval.engineKey,
              assets.slice(0, 1),
            ),
          ]
        : [holderBalances('sender', 'sender', config.address, assets)],
    ),
    reads.getSignerKey(chain, signingKey),
    approval ? reads.readThreshold(chain, approval.multisigAddress) : undefined,
  ]);

  return {
    chain,
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.isDefault === undefined ? {} : { default: config.isDefault }),
    network: config.network,
    mode: approval?.mode ?? 'single',
    address: config.address,
    multisig:
      approval && threshold
        ? {
            address: approval.multisigAddress,
            threshold: threshold.ok ? threshold.value : { error: threshold.error.code },
            engineKey: approval.engineKey,
          }
        : null,
    balances,
    signerKey: signerKeyView(signerKey),
  };
}

export const SENDERS_CACHE_MS = 15_000;

export function cachedSenders(
  configs: readonly SenderConfig[],
  reads: SenderReads,
): () => Promise<SenderView[]> {
  let cached: { at: number; views: Promise<SenderView[]> } | undefined;
  return () => {
    const now = reads.now().getTime();
    if (cached && now - cached.at < SENDERS_CACHE_MS) return cached.views;
    const views = Promise.all(configs.map((config) => readSender(config, reads)));
    const entry = { at: now, views };
    cached = entry;
    views.catch(() => {
      if (cached === entry) cached = undefined;
    });
    return views;
  };
}
