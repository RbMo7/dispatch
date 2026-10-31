import { describe, expect, it } from 'vitest';

import type { DispatchItem } from './call.js';
import type { Chain } from './chain.js';
import {
  factsNeeded,
  type FlagRuleDefinition,
  type FlagRuleFacts,
  type FlagRuleVersion,
  matchFlagRules,
} from './flag-rule.js';

const ALICE = '0x52908400098527886E0F7030069857D2E4169EE7';
const BOB = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';
const TOKEN = '0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359';

const pay = (amount: string, asset = 'USDC', recipient = ALICE): DispatchItem => ({
  call: { to: TOKEN, data: '0x', value: '0' },
  payment: { recipient, asset, amount },
});
const call = (to: string): DispatchItem => ({
  call: { to, data: '0x', value: '0' },
  payment: null,
});

function rule(definition: FlagRuleDefinition, chain: Chain = 'base'): FlagRuleVersion {
  return {
    ruleId: `rule-${definition.kind}`,
    version: 1,
    name: definition.kind,
    chain,
    enabled: true,
    definition,
    createdAt: new Date(0),
  };
}

const noFacts: FlagRuleFacts = { confirmedRecipients: new Set(), acceptedVolume: new Map() };

/** 5000 USDC, 6 decimals. */
const usdc5000 = { asset: 'USDC', limit: '5000', limitUnits: 5_000_000_000n };
/** 1.5 ETH, 18 decimals. */
const eth1_5 = { asset: 'ETH', limit: '1.5', limitUnits: 1_500_000_000_000_000_000n };

function matchedItems(
  definition: FlagRuleDefinition,
  items: DispatchItem[],
  facts = noFacts,
): number[] {
  return matchFlagRules('base', items, [rule(definition)], facts).flatMap((m) => m.items);
}

describe('matchFlagRules (ADR-0058)', () => {
  describe('item_over', () => {
    const itemOver = { kind: 'item_over', ...usdc5000 } as const;

    it('matches only an item strictly over the limit, in the smallest unit', () => {
      expect(matchedItems(itemOver, [pay('4999999999')])).toEqual([]);
      expect(matchedItems(itemOver, [pay('5000000000')])).toEqual([]);
      expect(matchedItems(itemOver, [pay('5000000001')])).toEqual([0]);
    });

    it('ignores other assets and call items, and lists every matching item', () => {
      const items = [pay('9000000000', 'ETH'), pay('6000000000'), call(TOKEN), pay('7000000000')];
      expect(matchedItems(itemOver, items)).toEqual([1, 3]);
    });

    it('compares an 18-decimal asset exactly', () => {
      const ethOver = { kind: 'item_over', ...eth1_5 } as const;
      expect(matchedItems(ethOver, [pay('1500000000000000000', 'ETH')])).toEqual([]);
      expect(matchedItems(ethOver, [pay('1500000000000000001', 'ETH')])).toEqual([0]);
    });
  });

  describe('dispatch_total_over', () => {
    const totalOver = { kind: 'dispatch_total_over', ...usdc5000 } as const;

    it('matches every item of the asset when their sum is over the limit', () => {
      expect(matchedItems(totalOver, [pay('2500000000'), pay('2499999999')])).toEqual([]);
      expect(matchedItems(totalOver, [pay('2500000000'), pay('2500000000')])).toEqual([]);
      expect(
        matchedItems(totalOver, [pay('2500000000'), pay('1', 'ETH'), pay('2500000001')]),
      ).toEqual([0, 2]);
    });
  });

  describe('daily_volume_over', () => {
    const dailyOver = { kind: 'daily_volume_over', ...usdc5000 } as const;
    const after = (units: bigint): FlagRuleFacts => ({
      ...noFacts,
      acceptedVolume: new Map([['USDC', units]]),
    });

    it('adds this Dispatch to the last 24 hours and matches only past the limit', () => {
      expect(matchedItems(dailyOver, [pay('1000000000')], after(3_999_999_999n))).toEqual([]);
      expect(matchedItems(dailyOver, [pay('1000000000')], after(4_000_000_000n))).toEqual([]);
      expect(matchedItems(dailyOver, [pay('1000000000')], after(4_000_000_001n))).toEqual([0]);
    });

    it('never matches a Dispatch that carries none of the asset', () => {
      expect(matchedItems(dailyOver, [pay('1', 'ETH')], after(9_000_000_000n))).toEqual([]);
    });
  });

  describe('first_time_recipient', () => {
    const firstTime = { kind: 'first_time_recipient' } as const;

    it('matches payments to recipients with no confirmed payment, ignoring case on Base', () => {
      const facts = { ...noFacts, confirmedRecipients: new Set([ALICE.toLowerCase()]) };
      expect(matchedItems(firstTime, [pay('1'), pay('1', 'USDC', BOB), call(BOB)], facts)).toEqual([
        1,
      ]);
    });

    it('compares Solana addresses exactly', () => {
      const key = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';
      const items: DispatchItem[] = [
        {
          call: { programId: 'p', accounts: [], data: '' },
          payment: { recipient: key, asset: 'SOL', amount: '1' },
        },
      ];
      const matches = matchFlagRules('solana', items, [rule(firstTime, 'solana')], {
        ...noFacts,
        confirmedRecipients: new Set([key.toLowerCase()]),
      });
      expect(matches.map((m) => m.items)).toEqual([[0]]);
    });
  });

  describe('recipient_not_allowlisted', () => {
    it('matches payments to recipients not on the list, ignoring case on Base', () => {
      const allow: FlagRuleDefinition = { kind: 'recipient_not_allowlisted', addresses: [ALICE] };
      expect(
        matchedItems(allow, [pay('1', 'USDC', ALICE.toLowerCase()), pay('1', 'USDC', BOB)]),
      ).toEqual([1]);
    });
  });

  describe('call_target_not_allowlisted', () => {
    it("matches only call items whose target is not on the list, never a payment's", () => {
      const allow: FlagRuleDefinition = { kind: 'call_target_not_allowlisted', addresses: [ALICE] };
      expect(matchedItems(allow, [pay('1'), call(ALICE.toLowerCase()), call(BOB)])).toEqual([2]);
    });
  });

  it('lists every matching rule with its own items, not only the first', () => {
    const rules = [
      rule({ kind: 'item_over', ...usdc5000 }),
      rule({ kind: 'recipient_not_allowlisted', addresses: [ALICE] }),
      rule({ kind: 'call_target_not_allowlisted', addresses: [ALICE] }),
    ];
    const items = [pay('6000000000'), pay('1', 'USDC', BOB), call(ALICE)];

    expect(
      matchFlagRules('base', items, rules, noFacts).map((m) => [m.rule.ruleId, m.items]),
    ).toEqual([
      ['rule-item_over', [0]],
      ['rule-recipient_not_allowlisted', [1]],
    ]);
  });
});

describe('factsNeeded', () => {
  it('asks only for what the rules read', () => {
    const items = [pay('1', 'USDC', ALICE), pay('1', 'USDC', ALICE.toLowerCase()), call(BOB)];

    expect(factsNeeded('base', items, [rule({ kind: 'item_over', ...usdc5000 })])).toEqual({
      recipients: [],
      assets: [],
    });
    expect(
      factsNeeded('base', items, [
        rule({ kind: 'first_time_recipient' }),
        rule({ kind: 'daily_volume_over', ...usdc5000 }),
        rule({ kind: 'daily_volume_over', ...eth1_5 }),
      ]),
    ).toEqual({ recipients: [ALICE.toLowerCase()], assets: ['USDC'] });
  });
});
