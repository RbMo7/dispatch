export interface Money {
  raw: string;
  decimals: number;
  asset: string;
}

/** Display decimals per known asset (design.md, Type). Others show up to 6, trailing zeros trimmed. */
export const DISPLAY_DECIMALS: Readonly<Record<string, number>> = { USDC: 2, SOL: 4, ETH: 4 };
const UNKNOWN_MAX_DECIMALS = 6;

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

/** The whole part (grouped) and the fraction with its point, rounded for display. */
export function splitAmount(money: Money): { whole: string; fraction: string } {
  const known = DISPLAY_DECIMALS[money.asset];
  const shown = known ?? Math.min(UNKNOWN_MAX_DECIMALS, money.decimals);
  const parts = digits(rescale(BigInt(money.raw), money.decimals, shown), shown);
  const fraction = known === undefined ? parts.fraction.replace(/0+$/, '') : parts.fraction;
  return {
    whole: `${parts.negative ? '-' : ''}${group(parts.whole)}`,
    fraction: fraction ? `.${fraction}` : '',
  };
}

/** `1,250.00`, rounded half to even at the asset's display decimals. */
export function formatAmount(money: Money): string {
  const { whole, fraction } = splitAmount(money);
  return whole + fraction;
}

/** The exact value as a plain decimal, every one of the asset's decimals kept: `1250.000000`. */
export function exactDecimal(money: Money): string {
  const parts = digits(BigInt(money.raw), money.decimals);
  return `${parts.negative ? '-' : ''}${parts.whole}${parts.fraction ? `.${parts.fraction}` : ''}`;
}

export function subtract(a: Money, b: Money): Money {
  return { ...a, raw: (BigInt(a.raw) - BigInt(b.raw)).toString() };
}

export function lessThan(a: Money, b: Money): boolean {
  return BigInt(a.raw) < BigInt(b.raw);
}

/** `part / whole` as a fraction for drawing a bar; precision past a pixel does not matter here. */
export function share(part: Money, whole: Money): number {
  const w = BigInt(whole.raw);
  if (w <= 0n) return 0;
  return Number((BigInt(part.raw) * 10_000n) / w) / 10_000;
}
