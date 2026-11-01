import type { Chain } from '../domain/chain.js';
import type { KnownAsset } from '../domain/known-asset.js';

/** An asset's decimal places by chain and symbol, enabled or not, so past payments still read; undefined for an unknown symbol. */
export type AssetDecimals = (chain: Chain, asset: string) => number | undefined;

/**
 * One chain's Known Assets as a Chain Handler reads them (ADR-0061). Every
 * call reads the registry's latest snapshot, so an asset added after startup
 * is seen on the next call.
 */
export interface AssetLookup<C extends Chain> {
  /** An enabled asset by symbol: what a new payment may name. */
  payable(symbol: string): KnownAsset<C> | undefined;
  /** Any asset by symbol, an enabled one first: what a balance or an accepted payment names. */
  bySymbol(symbol: string): KnownAsset<C> | undefined;
  /** Any asset by its mint or contract. */
  byAddress(address: string): KnownAsset<C> | undefined;
  /** Every asset, enabled or not. */
  all(): readonly KnownAsset<C>[];
}

/** Base addresses are hex, so case never tells two apart; Solana's base58 is case-sensitive. */
function addressKey(chain: Chain, address: string): string {
  return chain === 'base' ? address.toLowerCase() : address;
}

type ChainIndex = {
  rows: KnownAsset[];
  bySymbol: Map<string, KnownAsset>;
  byAddress: Map<string, KnownAsset>;
};

function index(rows: readonly KnownAsset[]): Map<Chain, ChainIndex> {
  const byChain = new Map<Chain, ChainIndex>();
  // Native first, then by symbol: the order every list shows.
  const ordered = [...rows].sort(
    (a, b) =>
      Number(b.kind === 'native') - Number(a.kind === 'native') ||
      a.symbol.localeCompare(b.symbol) ||
      a.addedAt.getTime() - b.addedAt.getTime(),
  );
  for (const row of ordered) {
    let chain = byChain.get(row.chain);
    if (!chain) {
      chain = { rows: [], bySymbol: new Map(), byAddress: new Map() };
      byChain.set(row.chain, chain);
    }
    chain.rows.push(row);
    const held = chain.bySymbol.get(row.symbol);
    if (!held || (!held.enabled && row.enabled)) chain.bySymbol.set(row.symbol, row);
    chain.byAddress.set(addressKey(row.chain, row.address), row);
  }
  return byChain;
}

/**
 * ADR-0061: the one place the engine reads Known Assets from. The API and the
 * worker each hold one, loaded from `known_assets` and refreshed when it
 * changes (`watchKnownAssets`).
 */
export class AssetRegistry {
  private byChain = new Map<Chain, ChainIndex>();
  /** Refreshes run one after another, so an older read never lands after a newer one. */
  private refreshing: Promise<void> = Promise.resolve();

  constructor(private readonly load: () => Promise<readonly KnownAsset[]>) {}

  /** A registry of fixed rows: for tools and tests that have no database. */
  static of(rows: readonly KnownAsset[]): AssetRegistry {
    const registry = new AssetRegistry(() => Promise.resolve(rows));
    registry.byChain = index(rows);
    return registry;
  }

  /** Reads every row again. Resolves once this read, and every one asked for before it, has landed. */
  refresh(): Promise<void> {
    this.refreshing = this.refreshing
      .catch(() => {})
      .then(async () => {
        this.byChain = index(await this.load());
      });
    return this.refreshing;
  }

  forChain<C extends Chain>(chain: C): AssetLookup<C> {
    const at = () => this.byChain.get(chain);
    return {
      payable: (symbol) => {
        const asset = at()?.bySymbol.get(symbol);
        return asset?.enabled ? (asset as KnownAsset<C>) : undefined;
      },
      bySymbol: (symbol) => at()?.bySymbol.get(symbol) as KnownAsset<C> | undefined,
      byAddress: (address) =>
        at()?.byAddress.get(addressKey(chain, address)) as KnownAsset<C> | undefined,
      all: () => (at()?.rows ?? []) as KnownAsset<C>[],
    };
  }

  /** Every row of `chain`, or of every chain: native first, then by symbol. */
  list(chain?: Chain): KnownAsset[] {
    if (chain) return [...(this.byChain.get(chain)?.rows ?? [])];
    return [...this.byChain.values()].flatMap((at) => at.rows);
  }

  get(id: string): KnownAsset | undefined {
    return this.list().find((asset) => asset.id === id);
  }

  /** The symbols a payment on `chain` may name: the native coin first, then every enabled token. */
  payableSymbols(chain: Chain): string[] {
    return this.list(chain)
      .filter((asset) => asset.enabled)
      .map((asset) => asset.symbol);
  }

  readonly decimalsOf: AssetDecimals = (chain, asset) =>
    this.byChain.get(chain)?.bySymbol.get(asset)?.decimals;
}
