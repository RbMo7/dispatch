import { describe, expect, it } from 'vitest';

import { parseSolanaKnownTokens } from './known-tokens.js';

describe('parseSolanaKnownTokens', () => {
  it('parses a comma-separated SYMBOL:mint:decimals list', () => {
    const registry = parseSolanaKnownTokens('USDC:EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:6,FOO:mint2:9');
    expect(registry).toEqual({
      USDC: { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
      FOO: { mint: 'mint2', decimals: 9 },
    });
  });

  it('returns an empty registry for an empty string', () => {
    expect(parseSolanaKnownTokens('')).toEqual({});
  });

  it('throws on a malformed entry', () => {
    expect(() => parseSolanaKnownTokens('USDC:onlymint')).toThrow();
    expect(() => parseSolanaKnownTokens('USDC:mint:notanumber')).toThrow();
  });

  it('rejects redefining the reserved SOL symbol', () => {
    expect(() => parseSolanaKnownTokens('SOL:somemint:9')).toThrow();
  });
});
