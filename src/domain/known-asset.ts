import type { Chain } from './chain.js';
import type { TokenKind } from './operator-action.js';
import { err, ok, type Result } from './result.js';

/** What a Known Asset is on each chain: its native coin, or a token under one of the chain's token standards. */
export type AssetKindByChain = {
  solana: 'native' | 'spl' | 'token-2022';
  base: 'native' | 'erc20';
};

export type AssetKind = AssetKindByChain[Chain];

/** `config` rows come from `*_KNOWN_TOKENS` (and the native coins) and are read-only; `console` rows are an operator's (ADR-0061). */
export type AssetSource = 'config' | 'console';

/** The address a native coin is stored under, since it has no mint or contract. */
export const NATIVE_ADDRESS = 'native';

type AssetFields<C extends Chain> = {
  chain: C;
  kind: AssetKindByChain[C];
  /** The mint or contract; `NATIVE_ADDRESS` for the native coin. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
};

/** What a config row is before it is stored: one native coin or one `*_KNOWN_TOKENS` entry. */
export type ConfigAsset<C extends Chain = Chain> = { [K in C]: AssetFields<K> }[C];

/** A token an operator adds from the console: what the chain said about it, with the symbol it will be paid in. */
export type NewKnownAsset<C extends Chain = Chain> = {
  [K in C]: AssetFields<K> & { kind: Exclude<AssetKindByChain[K], 'native'> };
}[C];

/** ADR-0061: one row of the `known_assets` registry. Never deleted, so history keeps resolving. */
export type KnownAsset<C extends Chain = Chain> = {
  [K in C]: AssetFields<K> & {
    id: string;
    source: AssetSource;
    /** Which token added it; null for a config row. */
    addedBy: TokenKind | null;
    addedAt: Date;
    enabled: boolean;
  };
}[C];

export const NATIVE_ASSETS: { [C in Chain]: ConfigAsset<C> } = {
  solana: {
    chain: 'solana',
    kind: 'native',
    address: NATIVE_ADDRESS,
    symbol: 'SOL',
    name: 'Solana',
    decimals: 9,
  },
  base: {
    chain: 'base',
    kind: 'native',
    address: NATIVE_ADDRESS,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
  },
};

/** Symbols are unique per chain among enabled assets, ignoring case, so `usdc` and `USDC` never both pay. */
export function symbolKey(symbol: string): string {
  return symbol.toUpperCase();
}

/** A `*_KNOWN_TOKENS` list names each address once and each symbol once: the registry keys on both. */
export function refuseRepeatedAsset(
  variable: string,
  seen: readonly ConfigAsset[],
  symbol: string,
  address: string,
): void {
  if (seen.some((asset) => symbolKey(asset.symbol) === symbolKey(symbol))) {
    throw new Error(`${variable} lists the symbol "${symbol}" more than once.`);
  }
  if (seen.some((asset) => asset.address.toLowerCase() === address.toLowerCase())) {
    throw new Error(`${variable} lists ${address} more than once.`);
  }
}

const SYMBOL = /^[A-Za-z0-9][A-Za-z0-9._$-]{0,19}$/;

/**
 * A symbol a payment can name: 1 to 20 letters, digits, `.`, `_`, `$` or `-`.
 * Commas and colons are out because `*_KNOWN_TOKENS` separates with them.
 */
export function parseAssetSymbol(raw: string): Result<string, string> {
  const symbol = raw.trim();
  return SYMBOL.test(symbol)
    ? ok(symbol)
    : err(
        `"${raw}" is not a usable symbol: use 1 to 20 letters, digits, ".", "_", "$" or "-", starting with a letter or digit`,
      );
}

/** One write the startup seed makes so the config rows match the configuration. */
export type ConfigSeedWrite =
  | { op: 'insert'; asset: ConfigAsset }
  | { op: 'update'; id: string; asset: ConfigAsset; enabled: true }
  | { op: 'disable'; id: string };

/** The rows `writes` leave behind: how a store without SQL, and `doctor` before the engine has run, apply a seed. */
export function applyConfigSeed(
  existing: readonly KnownAsset[],
  writes: readonly ConfigSeedWrite[],
  newRow: () => { id: string; addedAt: Date },
): KnownAsset[] {
  const rows = new Map(existing.map((row) => [row.id, row]));
  for (const write of writes) {
    if (write.op === 'disable') {
      rows.set(write.id, { ...rows.get(write.id)!, enabled: false });
      continue;
    }
    const { id, addedAt } = write.op === 'insert' ? newRow() : rows.get(write.id)!;
    rows.set(id, {
      ...write.asset,
      id,
      addedAt,
      source: 'config',
      addedBy: null,
      enabled: true,
    });
  }
  return [...rows.values()];
}

/**
 * ADR-0061: what the stored rows need so the registry holds exactly the
 * configured assets as enabled config rows. A config row the configuration
 * no longer lists is disabled, so removing a variable entry still stops
 * payments in it. A console row at a configured address becomes a config row.
 * Writing the result twice changes nothing, so the API and the worker can both
 * run it at startup.
 */
export function planConfigSeed(
  existing: readonly KnownAsset[],
  configured: readonly ConfigAsset[],
): Result<ConfigSeedWrite[], string> {
  const writes: ConfigSeedWrite[] = [];
  const key = (chain: Chain, address: string) => `${chain}:${address}`;
  const atAddress = new Map(existing.map((row) => [key(row.chain, row.address), row]));
  const wanted = new Set(configured.map((asset) => key(asset.chain, asset.address)));

  for (const asset of configured) {
    const clash = existing.find(
      (row) =>
        row.chain === asset.chain &&
        row.enabled &&
        row.address !== asset.address &&
        !(row.source === 'config' && !wanted.has(key(row.chain, row.address))) &&
        symbolKey(row.symbol) === symbolKey(asset.symbol),
    );
    if (clash) {
      return err(
        `${asset.symbol} on ${asset.chain} is configured as ${asset.address}, but the asset ${clash.address} added from the console already uses that symbol: disable it under Assets, or configure another symbol`,
      );
    }
    const row = atAddress.get(key(asset.chain, asset.address));
    if (!row) {
      writes.push({ op: 'insert', asset });
    } else if (
      row.source !== 'config' ||
      !row.enabled ||
      row.symbol !== asset.symbol ||
      row.decimals !== asset.decimals ||
      row.kind !== asset.kind ||
      row.name !== asset.name
    ) {
      writes.push({ op: 'update', id: row.id, asset, enabled: true });
    }
  }
  // Disables first, so a symbol a dropped entry held is free before another row takes it.
  const disables: ConfigSeedWrite[] = existing
    .filter(
      (row) => row.source === 'config' && row.enabled && !wanted.has(key(row.chain, row.address)),
    )
    .map((row) => ({ op: 'disable', id: row.id }));
  return ok([...disables, ...writes]);
}
