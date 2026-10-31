import type { Balance } from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { AssetDecimals } from './asset-decimals.js';
import type { DispatchError } from '../domain/errors.js';
import type { AssetAmount } from '../domain/proposal.js';
import type { Result } from '../domain/result.js';
import type { CommittedHolder } from '../repository/dispatch-store.js';
import type { PolicyRead, SignerPins } from '../signer/client.js';

/**
 * #111: what one enabled chain's Sender is, from config. `assets` lists the
 * native asset first, then every known token. `approval` is present exactly
 * for a Multisig Sender (ADR-0049).
 */
export type SenderConfig = {
  chain: Chain;
  /** What pays the payments: the plain key, the Squads vault, or the Safe. */
  address: string;
  assets: readonly string[];
  assetDecimals: AssetDecimals;
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

/** The external reads a SenderView needs. Each can fail on its own. */
export type SenderReads = {
  getBalance(chain: Chain, address: string, asset: string): Promise<Result<Balance, DispatchError>>;
  readPins(address: string): Promise<PolicyRead>;
  readThreshold(chain: Chain): Promise<Result<number, DispatchError>>;
  listCommitted(chain: Chain, holder: CommittedHolder, timedOutSince: Date): Promise<AssetAmount[]>;
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
  mode: 'single' | 'squads' | 'safe';
  address: string;
  multisig: {
    address: string;
    threshold: number | FieldError;
    engineKey: string;
  } | null;
  balances: HolderBalances[];
  /** ADR-0055: what the Signer says the engine's signing key is pinned to. */
  signerKey: SignerPins | FieldError;
};

const POLICY_READ_ERRORS: Record<Exclude<PolicyRead['kind'], 'pins'>, string> = {
  'no-key': 'the Signer has no key for this address',
  'old-signer': 'the Signer is too old to report a key policy',
  unreachable: 'the Signer could not be reached',
};

export async function readSender(config: SenderConfig, reads: SenderReads): Promise<SenderView> {
  const { chain, approval } = config;
  const timedOutSince = new Date(reads.now().getTime() - (approval?.rewatchWindowMs ?? 0));
  const holderBalances = async (
    holder: HolderBalances['holder'],
    committedHolder: CommittedHolder,
    address: string,
    assets: readonly string[],
  ): Promise<HolderBalances> => {
    const committed = await reads.listCommitted(chain, committedHolder, timedOutSince);
    return {
      holder,
      address,
      assets: await Promise.all(
        assets.map(async (asset) => {
          const balance = await reads.getBalance(chain, address, asset);
          const decimals = config.assetDecimals(chain, asset);
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
  const signingKey = approval?.engineKey ?? config.address;
  const [balances, pins, threshold] = await Promise.all([
    Promise.all(
      approval
        ? [
            holderBalances(approval.holders.sender, 'sender', config.address, config.assets),
            holderBalances(
              approval.holders.proposer,
              'proposer',
              approval.engineKey,
              config.assets.slice(0, 1),
            ),
          ]
        : [holderBalances('sender', 'sender', config.address, config.assets)],
    ),
    reads.readPins(signingKey),
    approval ? reads.readThreshold(chain) : undefined,
  ]);

  return {
    chain,
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
    signerKey: pins.kind === 'pins' ? pins.pins : { error: POLICY_READ_ERRORS[pins.kind] },
  };
}

export const SENDERS_CACHE_MS = 15_000;

/** Every Sender, read at most once per 15 s however often a console polls; a failed read is not kept. */
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
