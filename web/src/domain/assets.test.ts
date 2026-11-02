import { describe, expect, it } from 'vitest';

import { assetNames, exactDecimal, formatAmount, type KnownAsset, share } from './assets';

const usdc = (raw: string) => ({ raw, decimals: 6, asset: 'USDC' });

describe('amounts from raw integer strings', () => {
  it('shows USDC at 2 decimals, grouped', () => {
    expect(formatAmount(usdc('1250000000'))).toBe('1,250.00');
    expect(formatAmount(usdc('12480000000'))).toBe('12,480.00');
  });

  it('rounds half to even at the display decimals', () => {
    expect(formatAmount(usdc('1005000'))).toBe('1.00');
    expect(formatAmount(usdc('1015000'))).toBe('1.02');
    expect(formatAmount(usdc('1015001'))).toBe('1.02');
    expect(formatAmount(usdc('1004999'))).toBe('1.00');
    expect(formatAmount(usdc('999995000'))).toBe('1,000.00');
  });

  it('handles 18-decimal ETH beyond what a double holds', () => {
    const eth = { raw: '123456789012345678901234567', decimals: 18, asset: 'ETH' };
    expect(formatAmount(eth)).toBe('123,456,789.0123');
    expect(exactDecimal(eth)).toBe('123456789.012345678901234567');
  });

  it('shows an unknown asset at up to 6 decimals with trailing zeros trimmed', () => {
    expect(formatAmount({ raw: '1500000000', decimals: 9, asset: 'JUP' })).toBe('1.5');
    expect(formatAmount({ raw: '1234567891', decimals: 9, asset: 'JUP' })).toBe('1.234568');
    expect(formatAmount({ raw: '42', decimals: 0, asset: 'PTS' })).toBe('42');
  });

  it('pads values smaller than one unit', () => {
    expect(formatAmount({ raw: '81400000', decimals: 9, asset: 'SOL' })).toBe('0.0814');
    expect(exactDecimal({ raw: '7', decimals: 6, asset: 'USDC' })).toBe('0.000007');
  });

  it('keeps the first significant digits of an amount too small for its display decimals', () => {
    expect(formatAmount({ raw: '1000000000000', decimals: 18, asset: 'ETH' })).toBe('0.000001');
    expect(formatAmount({ raw: '1234567890123', decimals: 18, asset: 'ETH' })).toBe('0.0000012');
    expect(formatAmount({ raw: '7', decimals: 6, asset: 'USDC' })).toBe('0.000007');
    expect(formatAmount({ raw: '1', decimals: 9, asset: 'SOL' })).toBe('0.000000001');
    expect(formatAmount({ raw: '-5000', decimals: 6, asset: 'USDC' })).toBe('-0.005');
  });

  it('rounds as usual once the display decimals hold a non-zero digit', () => {
    expect(formatAmount({ raw: '60000000000000', decimals: 18, asset: 'ETH' })).toBe('0.0001');
    expect(formatAmount(usdc('6000'))).toBe('0.01');
    expect(formatAmount(usdc('5000'))).toBe('0.005');
    expect(formatAmount(usdc('0'))).toBe('0.00');
  });

  it('gives a bar share without losing the order of magnitude', () => {
    expect(share(usdc('700000000'), usdc('1842300000'))).toBeCloseTo(0.38, 2);
    expect(share(usdc('1'), usdc('0'))).toBe(0);
  });
});

describe('asset names from the registry', () => {
  const row = (chain: 'solana' | 'base', symbol: string, name: string, enabled = true) =>
    ({ chain, symbol, name, enabled }) as KnownAsset;

  it('names an asset by chain and symbol, ignoring case', () => {
    const names = assetNames([
      row('base', 'USDC', 'USD Coin'),
      row('solana', 'USDC', 'Circle USD'),
    ]);
    expect(names('base', 'usdc')).toBe('USD Coin');
    expect(names('solana', 'USDC')).toBe('Circle USD');
  });

  it('prefers the enabled asset over a disabled one with the same symbol', () => {
    const names = assetNames([
      row('base', 'LUSD', 'Live Dollar'),
      row('base', 'LUSD', 'Old Dollar', false),
    ]);
    expect(names('base', 'LUSD')).toBe('Live Dollar');
  });

  it('falls back to the symbol for an asset it does not hold', () => {
    expect(assetNames([])('base', 'USDT')).toBe('USDT');
  });
});
