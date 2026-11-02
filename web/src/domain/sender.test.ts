import { describe, expect, it } from 'vitest';

import type { Chain } from './chains';
import { type Sender, senderChoices, sharedChains } from './sender';

function sender(chain: Chain, name: string): Sender {
  return {
    chain,
    name,
    isDefault: false,
    network: 'unknown',
    mode: 'single',
    address: `${chain}-${name}`,
    multisig: null,
    balances: [],
    signerKey: { ok: false, error: 'the worker has not read this key yet' },
    foreignActivity: null,
  };
}

describe('the Sender filter', () => {
  const senders = [
    sender('solana', 'payouts'),
    sender('solana', 'refunds'),
    sender('base', 'payouts'),
  ];

  it('knows which chains have more than one Sender', () => {
    expect([...sharedChains(senders)]).toEqual(['solana']);
  });

  it('offers every name in view, a name shared across chains once', () => {
    expect(senderChoices(senders, 'all')).toEqual(['payouts', 'refunds']);
    expect(senderChoices(senders, 'solana')).toEqual(['payouts', 'refunds']);
  });

  it('offers nothing where every chain in view has one Sender', () => {
    expect(senderChoices(senders, 'base')).toBeNull();
    expect(
      senderChoices([sender('solana', 'default'), sender('base', 'default')], 'all'),
    ).toBeNull();
  });
});
