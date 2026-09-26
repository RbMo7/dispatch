import { describe, expect, it } from 'vitest';

import { parseBaseKnownTokens } from './known-tokens.js';

describe('parseBaseKnownTokens', () => {
  it('parses a comma-separated SYMBOL:contractAddress:decimals list', () => {
    const registry = parseBaseKnownTokens(
      'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6,FOO:0x0000000000000000000000000000000000000f:9',
    );
    expect(registry).toEqual({
      USDC: { contractAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6 },
      FOO: { contractAddress: '0x0000000000000000000000000000000000000f', decimals: 9 },
    });
  });

  it('returns an empty registry for an empty string', () => {
    expect(parseBaseKnownTokens('')).toEqual({});
  });

  it('throws on a malformed entry', () => {
    expect(() => parseBaseKnownTokens('USDC:onlyaddress')).toThrow();
    expect(() => parseBaseKnownTokens('USDC:0xabc:notanumber')).toThrow();
  });

  it('rejects redefining the reserved ETH symbol', () => {
    expect(() => parseBaseKnownTokens('ETH:0xabc:18')).toThrow();
  });
});
