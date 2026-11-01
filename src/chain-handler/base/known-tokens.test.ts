import { describe, expect, it } from 'vitest';

import { parseBaseKnownTokens } from './known-tokens.js';

describe('parseBaseKnownTokens', () => {
  it('parses a comma-separated SYMBOL:contractAddress:decimals list', () => {
    const registry = parseBaseKnownTokens(
      'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6,FOO:0x000000000000000000000000000000000000000f:9',
    );
    expect(registry).toEqual([
      {
        chain: 'base',
        kind: 'erc20',
        address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        symbol: 'USDC',
        name: 'USDC',
        decimals: 6,
      },
      {
        chain: 'base',
        kind: 'erc20',
        address: '0x000000000000000000000000000000000000000F',
        symbol: 'FOO',
        name: 'FOO',
        decimals: 9,
      },
    ]);
  });

  it('returns no tokens for an empty string', () => {
    expect(parseBaseKnownTokens('')).toEqual([]);
  });

  it('refuses a symbol or a contract listed twice, since the registry keys on both', () => {
    const usdc = 'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6';
    expect(() =>
      parseBaseKnownTokens(`${usdc},usdc:0x000000000000000000000000000000000000000f:6`),
    ).toThrow(/symbol "usdc" more than once/);
    expect(() =>
      parseBaseKnownTokens(`${usdc},USDT:0x036cbd53842c5426634e7929541ec2318f3dcf7e:6`),
    ).toThrow(/more than once/);
  });

  it('throws on a malformed entry', () => {
    expect(() => parseBaseKnownTokens('USDC:onlyaddress')).toThrow();
    expect(() => parseBaseKnownTokens('USDC:0xabc:notanumber')).toThrow();
  });

  it('rejects redefining the reserved ETH symbol', () => {
    expect(() => parseBaseKnownTokens('ETH:0xabc:18')).toThrow();
  });
});
