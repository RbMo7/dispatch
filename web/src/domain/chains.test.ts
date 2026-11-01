import { describe, expect, it } from 'vitest';

import { type Network, proposalUrl, txLink } from './chains';
import type { ChainRef } from './dispatch';

const SIG =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const HASH = '0xaa1f5e0c3b2d7a9e4f6c8b1d0e2a3f5c7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f';
const SQUADS: ChainRef = {
  kind: 'squads',
  multisig: '8xQyR1sT2uV3wX4yZ5a6B7c8D9e1F2g3H4i5J6k7L8m9',
  proposal: 'Prop1111',
  transactionIndex: 4,
};
const SAFE: ChainRef = {
  kind: 'safe',
  safe: '0x1111111111111111111111111111111111111111',
  safeTxHash: HASH,
  nonce: 7,
};

describe('explorer links for the engine network', () => {
  it.each<[Network, string, { label: string; href: string } | null]>([
    ['mainnet-beta', SIG, { label: 'View on Solscan', href: `https://solscan.io/tx/${SIG}` }],
    [
      'devnet',
      SIG,
      { label: 'View on Solscan', href: `https://solscan.io/tx/${SIG}?cluster=devnet` },
    ],
    [
      'testnet',
      SIG,
      { label: 'View on Solscan', href: `https://solscan.io/tx/${SIG}?cluster=testnet` },
    ],
    ['base', HASH, { label: 'View on Basescan', href: `https://basescan.org/tx/${HASH}` }],
    [
      'base-sepolia',
      HASH,
      { label: 'View on Basescan', href: `https://sepolia.basescan.org/tx/${HASH}` },
    ],
    ['unknown', SIG, null],
    [{ chainId: 31337 }, HASH, null],
  ])('links a transaction on %j', (network, hash, link) => {
    expect(txLink(network, hash)).toEqual(link);
  });
});

describe('multisig app links for the engine network', () => {
  it.each<[Network, ChainRef, string | null]>([
    ['mainnet-beta', SQUADS, `https://app.squads.so/squads/${SQUADS.multisig}/transactions`],
    ['devnet', SQUADS, null],
    ['testnet', SQUADS, null],
    ['unknown', SQUADS, null],
    ['base', SAFE, `https://app.safe.global/transactions/queue?safe=base:${SAFE.safe}`],
    ['base-sepolia', SAFE, `https://app.safe.global/transactions/queue?safe=basesep:${SAFE.safe}`],
    [{ chainId: 31337 }, SAFE, null],
    ['unknown', SAFE, null],
  ])('links a Proposal on %j', (network, ref, href) => {
    expect(proposalUrl(network, ref)).toBe(href);
  });
});
