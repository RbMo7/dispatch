import { describe, expect, it } from 'vitest';

import { parseSolanaKnownTokens } from './known-tokens.js';

describe('parseSolanaKnownTokens', () => {
  it('parses a comma-separated SYMBOL:mint:decimals list', () => {
    const registry = parseSolanaKnownTokens(
      'USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:6,FOO:mint2:9',
    );
    expect(registry).toEqual([
      {
        chain: 'solana',
        kind: 'spl',
        address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        symbol: 'USDC',
        name: 'USDC',
        decimals: 6,
      },
      { chain: 'solana', kind: 'spl', address: 'mint2', symbol: 'FOO', name: 'FOO', decimals: 9 },
    ]);
  });

  it('parses an optional token-2022 program, and refuses any other (#41)', () => {
    expect(
      parseSolanaKnownTokens('PYUSD:mintP:6:token-2022,USDC:mintU:6').map(({ symbol, kind }) => [
        symbol,
        kind,
      ]),
    ).toEqual([
      ['PYUSD', 'token-2022'],
      ['USDC', 'spl'],
    ]);
    expect(() => parseSolanaKnownTokens('X:mint:6:token-2023')).toThrow(/malformed/);
    expect(() => parseSolanaKnownTokens('X:mint:6:token-2022:extra')).toThrow(/malformed/);
  });

  it('returns no tokens for an empty string', () => {
    expect(parseSolanaKnownTokens('')).toEqual([]);
  });

  it('refuses a symbol or a mint listed twice, since the registry keys on both', () => {
    expect(() => parseSolanaKnownTokens('USDC:mintA:6,usdc:mintB:6')).toThrow(/more than once/);
    expect(() => parseSolanaKnownTokens('USDC:mintA:6,USDT:mintA:6')).toThrow(/more than once/);
  });

  it('throws on a malformed entry', () => {
    expect(() => parseSolanaKnownTokens('USDC:onlymint')).toThrow();
    expect(() => parseSolanaKnownTokens('USDC:mint:notanumber')).toThrow();
  });

  it('rejects redefining the reserved SOL symbol', () => {
    expect(() => parseSolanaKnownTokens('SOL:somemint:9')).toThrow();
  });
});
