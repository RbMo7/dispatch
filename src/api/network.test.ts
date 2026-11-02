import { describe, expect, it } from 'vitest';

import { baseNetwork, solanaNetwork } from './network.js';

describe('baseNetwork', () => {
  it.each([
    [8453, 'base'],
    [84532, 'base-sepolia'],
    [31337, { chainId: 31337 }],
  ])('names chain id %s as %j', (chainId, network) => {
    expect(baseNetwork(chainId)).toEqual(network);
  });
});

describe('solanaNetwork', () => {
  it.each([
    ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', 'mainnet-beta'],
    ['EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', 'devnet'],
    ['4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY', 'testnet'],
    ['SomeLocalValidatorGenesis1111111111111111111', 'unknown'],
    [undefined, 'unknown'],
  ])('names genesis hash %s as %s', (genesisHash, network) => {
    expect(solanaNetwork(genesisHash)).toBe(network);
  });
});
