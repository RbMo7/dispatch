import { CHAINS, type Chain } from './chains';
import type { TokenKind } from './flagRules';

/** An amount in an asset's smallest unit, with what it takes to show it. */
export interface Quantity {
  raw: string;
  decimals: number;
  /** The symbol, as payments name it: `USDC`. */
  asset: string;
}

/** A quantity with its asset's name from the registry, resolved where the console reads the API. */
export interface Money extends Quantity {
  /** `USD Coin`; the symbol again when the registry has no row for it. */
  name: string;
}

export type AssetKind = 'native' | 'spl' | 'token-2022' | 'erc20';

export const ASSET_KINDS: Record<AssetKind, string> = {
  native: 'Native',
  spl: 'SPL',
  'token-2022': 'Token-2022',
  erc20: 'ERC-20',
};

/** A row of `GET /v1/assets` (ADR-0061). */
export interface KnownAsset {
  id: string;
  chain: Chain;
  /** The mint or contract; `native` for the chain's coin. */
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  kind: AssetKind;
  /** `config` rows come from the engine's variables and can't be changed from the console. */
  source: 'config' | 'console';
  enabled: boolean;
  addedBy: TokenKind | null;
  addedAt: Date;
}

/** `POST /v1/assets/preview`: what adding the address would store, read from the chain. */
export interface AssetPreview {
  chain: Chain;
  kind: Exclude<AssetKind, 'native'>;
  address: string;
  decimals: number;
  symbol: string;
  name: string;
  /** What the chain itself gives, empty where it gives nothing. */
  onChain: { symbol: string; name: string };
  supply: string;
}

/** An asset's name by chain and symbol; the symbol itself for one the registry does not hold. */
export type AssetNames = (chain: Chain, symbol: string) => string;

export function assetNames(assets: readonly KnownAsset[]): AssetNames {
  const names = new Map<string, string>();
  const key = (chain: Chain, symbol: string) => `${chain}/${symbol.toLowerCase()}`;
  // A disabled asset may share its symbol with the enabled one that replaced it: the enabled one wins.
  for (const asset of [...assets].sort((a, b) => Number(a.enabled) - Number(b.enabled))) {
    names.set(key(asset.chain, asset.symbol), asset.name);
  }
  return (chain, symbol) => names.get(key(chain, symbol)) ?? symbol;
}

/** `USD Coin (USDC)`, or just `USDC` when the name is the symbol. */
export function assetLabel(money: Pick<Money, 'asset' | 'name'>): string {
  return money.name === money.asset ? money.asset : `${money.name} (${money.asset})`;
}

/** Display decimals per known asset (design.md, Type). Others show up to 6, trailing zeros trimmed. */
export const DISPLAY_DECIMALS: Readonly<Record<string, number>> = { USDC: 2, SOL: 4, ETH: 4 };
const UNKNOWN_MAX_DECIMALS = 6;
/** How many significant digits an amount too small for its display decimals keeps. */
const SMALL_SIGNIFICANT = 2;

const TEN = 10n;

/** Rescales an integer from `from` decimals to `to`, rounding half to even. */
function rescale(value: bigint, from: number, to: number): bigint {
  if (to >= from) return value * TEN ** BigInt(to - from);
  const divisor = TEN ** BigInt(from - to);
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  let quotient = magnitude / divisor;
  const twice = (magnitude % divisor) * 2n;
  if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) quotient += 1n;
  return negative ? -quotient : quotient;
}

function digits(
  value: bigint,
  decimals: number,
): { negative: boolean; whole: string; fraction: string } {
  const negative = value < 0n;
  const text = (negative ? -value : value).toString().padStart(decimals + 1, '0');
  return {
    negative,
    whole: text.slice(0, text.length - decimals),
    fraction: text.slice(text.length - decimals),
  };
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/**
 * The decimals to show: the asset's display decimals, or for an amount that
 * would round to zero there, enough to keep its first significant digits.
 */
function shownDecimals(money: Quantity): { shown: number; trim: boolean } {
  const known = DISPLAY_DECIMALS[money.asset];
  const shown = known ?? Math.min(UNKNOWN_MAX_DECIMALS, money.decimals);
  const value = BigInt(money.raw);
  if (value === 0n || rescale(value, money.decimals, shown) !== 0n) {
    return { shown, trim: known === undefined };
  }
  const length = (value < 0n ? -value : value).toString().length;
  const firstSignificant = money.decimals - length + 1;
  return {
    shown: Math.min(money.decimals, firstSignificant + SMALL_SIGNIFICANT - 1),
    trim: true,
  };
}

/** The whole part (grouped) and the fraction with its point, rounded for display. */
export function splitAmount(money: Quantity): { whole: string; fraction: string } {
  const { shown, trim } = shownDecimals(money);
  const parts = digits(rescale(BigInt(money.raw), money.decimals, shown), shown);
  const fraction = trim ? parts.fraction.replace(/0+$/, '') : parts.fraction;
  return {
    whole: `${parts.negative ? '-' : ''}${group(parts.whole)}`,
    fraction: fraction ? `.${fraction}` : '',
  };
}

/** `1,250.00`, rounded half to even at the asset's display decimals; `0.0000012` below them. */
export function formatAmount(money: Quantity): string {
  const { whole, fraction } = splitAmount(money);
  return whole + fraction;
}

/** The exact value as a plain decimal, every one of the asset's decimals kept: `1250.000000`. */
export function exactDecimal(money: Quantity): string {
  const parts = digits(BigInt(money.raw), money.decimals);
  return `${parts.negative ? '-' : ''}${parts.whole}${parts.fraction ? `.${parts.fraction}` : ''}`;
}

export function subtract<T extends Quantity>(a: T, b: Quantity): T {
  return { ...a, raw: (BigInt(a.raw) - BigInt(b.raw)).toString() };
}

export function lessThan(a: Quantity, b: Quantity): boolean {
  return BigInt(a.raw) < BigInt(b.raw);
}

/** `part / whole` as a fraction for drawing a bar; precision past a pixel does not matter here. */
export function share(part: Quantity, whole: Quantity): number {
  const w = BigInt(whole.raw);
  if (w <= 0n) return 0;
  return Number((BigInt(part.raw) * 10_000n) / w) / 10_000;
}

/** What a refused asset change means, in plain words, and the engine's own words where they add a fact. */
export interface AssetRefusal {
  text: string;
  detail: string | null;
}

/**
 * The words for a refused Preview, Add, enable or disable (docs/openapi.yaml,
 * Assets). `symbol` is the one the operator typed, if any.
 */
export function explainAssetRefusal(
  refusal: { code: string; message: string },
  context: { chain: Chain; symbol?: string | undefined; change: 'add' | 'enable' | 'disable' },
): AssetRefusal {
  const chain = CHAINS[context.chain].label;
  const address = context.chain === 'solana' ? 'mint' : 'contract';
  switch (refusal.code) {
    case 'NOT_A_TOKEN':
      return {
        text: `This address is not a token on ${chain}. Paste the token's ${address} address, not a wallet.`,
        detail: null,
      };
    case 'NOT_PAYABLE':
      return {
        text: 'The engine cannot pay out this token correctly, so it cannot be added.',
        detail: refusal.message,
      };
    case 'SYMBOL_REQUIRED':
      return {
        text: 'This token publishes no symbol. Give it one under Symbol, then preview again.',
        detail: null,
      };
    case 'SYMBOL_TAKEN':
      if (context.change === 'enable') {
        return {
          text: `Another enabled asset on ${chain} uses this symbol. Disable that one first.`,
          detail: null,
        };
      }
      return {
        text: context.symbol
          ? `${context.symbol} is already used on ${chain}. Choose another symbol, then preview again.`
          : `The token's own symbol is already used on ${chain}. Give it another under Symbol, then preview again.`,
        detail: null,
      };
    case 'ASSET_EXISTS':
      return { text: `This token is already a known asset on ${chain}.`, detail: refusal.message };
    case 'CONFIG_ASSET':
      return {
        text: "This asset comes from the engine's configuration. Change it there and restart.",
        detail: null,
      };
    case 'RPC_UNAVAILABLE':
      return {
        text: `The engine could not read ${chain} just now. Try again in a moment.`,
        detail: null,
      };
    default:
      return { text: `The engine refused it: ${refusal.message}`, detail: null };
  }
}
