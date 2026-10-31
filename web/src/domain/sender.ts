import { lessThan, type Money, subtract } from './assets';
import type { Chain, Network } from './chains';

/** A field the engine could not read: only its own value degrades, never the page. */
export type Read<T> = { ok: true; value: T } | { ok: false; error: string };

export type SenderMode = 'single' | 'squads' | 'safe';

/** The Funding Check's names for a balance (`chainDetail.holder`). */
export type HolderName = 'sender' | 'vault' | 'safe' | 'memberKey' | 'executor';

export interface AssetBalance {
  asset: string;
  /** Null when the asset is no longer configured, so there are no decimals to read it by. */
  decimals: number | null;
  balance: Read<Money>;
  committed: Money;
}

export interface Holding {
  holder: HolderName;
  address: string;
  assets: AssetBalance[];
}

export interface SignerKey {
  address: string;
  curve: string;
  chainIds: number[];
  allowedSafe: string | null;
  allowedMultisig: string | null;
}

export interface Sender {
  chain: Chain;
  network: Network;
  mode: SenderMode;
  address: string;
  multisig: { address: string; threshold: Read<number>; engineKey: string } | null;
  balances: Holding[];
  signerKey: Read<SignerKey>;
}

export const HOLDER_LABEL: Record<HolderName, string> = {
  sender: 'Sender',
  vault: 'Vault',
  safe: 'Safe',
  memberKey: 'Member key',
  executor: 'Executor',
};

export const MODE_LABEL: Record<SenderMode, string> = {
  single: 'Single key',
  squads: 'Squads',
  safe: 'Safe',
};

/** "Squads, 2 of 3", "Safe, 2 of 3" or "Single key". */
export function signingLine(sender: Sender): string {
  if (!sender.multisig) return MODE_LABEL.single;
  const { threshold } = sender.multisig;
  return threshold.ok
    ? `${MODE_LABEL[sender.mode]}, ${threshold.value} to approve`
    : MODE_LABEL[sender.mode];
}

/** The holding that pays the payments: the plain key, the vault or the Safe. */
export function payer(sender: Sender): Holding | undefined {
  return sender.balances.find((h) => h.holder !== 'memberKey' && h.holder !== 'executor');
}

/** The engine's own key on a Multisig Sender, which pays the network cost. */
export function feePayer(sender: Sender): Holding | undefined {
  return sender.balances.find((h) => h.holder === 'memberKey' || h.holder === 'executor');
}

/** What is left once open work is held back; negative when the balance cannot cover it. */
export function free(balance: Money, committed: Money): Money {
  return subtract(balance, committed);
}

export function isShort(balance: Money, committed: Money): boolean {
  return lessThan(balance, committed);
}

/**
 * The one figure a Sender card leads with: the token carrying the most
 * committed work, else the first token holding anything, else the native asset.
 */
export function headlineAsset(holding: Holding): AssetBalance | undefined {
  const [native, ...tokens] = holding.assets;
  const committed = [...tokens, ...(native ? [native] : [])].filter(
    (a) => BigInt(a.committed.raw) > 0n,
  );
  if (committed.length > 0) {
    return committed.reduce((a, b) => (BigInt(b.committed.raw) > BigInt(a.committed.raw) ? b : a));
  }
  return tokens.find((a) => a.balance.ok && BigInt(a.balance.value.raw) > 0n) ?? native;
}

/** Whether the engine's key is pinned to this Sender's multisig (ADR-0055). Null for a single key. */
export function pinnedToMultisig(sender: Sender): boolean | null {
  if (!sender.multisig || !sender.signerKey.ok) return null;
  const key = sender.signerKey.value;
  if (sender.mode === 'safe') {
    // EVM addresses compare without their checksum casing; base58 is case-sensitive.
    return key.allowedSafe?.toLowerCase() === sender.multisig.address.toLowerCase();
  }
  return key.allowedMultisig === sender.multisig.address;
}
