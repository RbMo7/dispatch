import { describe, expect, it } from 'vitest';

import type { Chain } from './chains';
import { cardBalances, type Sender, senderChoices, sharedChains } from './sender';

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

describe("a Sender card's balances", () => {
  const money = (asset: string, raw: string, decimals: number) => ({
    asset,
    name: asset,
    raw,
    decimals,
  });
  const asset = (symbol: string, balance: string, committed: string, decimals = 6) => ({
    asset: symbol,
    decimals,
    balance: { ok: true as const, value: money(symbol, balance, decimals) },
    committed: money(symbol, committed, decimals),
  });

  it('leads with the native coin even when a token carries the committed work', () => {
    const { native, tokens } = cardBalances({
      holder: 'sender',
      address: 'Payer111',
      assets: [
        asset('SOL', '2000000000', '0', 9),
        asset('CASPL', '5000000', '4000000'),
        asset('HBD', '0', '0'),
        asset('USDC', '1', '0'),
      ],
    });
    expect(native?.asset).toBe('SOL');
    expect(tokens.map((t) => t.asset)).toEqual(['CASPL', 'USDC']);
  });
});
