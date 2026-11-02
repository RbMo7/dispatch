import { toFunctionSelector } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { baseEffectsFrom } from '../chain-handler/base/effects.js';
import { EFFECTS_BOUNDS } from '../domain/effects.js';
import { decodeCall, decodeEffects } from './decode.js';
import {
  AGGREGATOR,
  asset,
  known,
  BASE_PAYOUTS,
  BASE_REFUNDS,
  BASE_RELAY,
  ETH,
  F22,
  FLOW,
  FSPL,
  MEMO_PROGRAM,
  readRecorded,
  recorded,
  SOL,
  SOL_PAYOUTS,
  SOL_REFUNDS,
  SOL_RELAY,
  TOKEN_PROGRAM,
  VAULT,
} from './test-support/recorded.js';

const baseInput = (name: string) => {
  const { to, input, value } = recorded(name).rpc.eth_getTransactionByHash as {
    to: string;
    input: string;
    value: string;
  };
  return { to, data: input, value: BigInt(value).toString() };
};

afterEach(() => vi.restoreAllMocks());

describe('Base effects and calls, from recorded transactions (ADR-0063)', () => {
  it('row 2: an ERC-20 payment moves 1.5 FLOW from the Sender, and its call is transfer(to, amount)', async () => {
    const effects = await readRecorded('erc20-payment');
    const view = decodeEffects(effects, known);

    expect(view.transfers).toEqual([
      {
        standard: 'erc20',
        token: FLOW,
        from: BASE_PAYOUTS,
        to: BASE_REFUNDS,
        amount: '1500000',
        asset: asset(FLOW, 'FLOW', 6),
        formatted: '1.5',
      },
    ]);
    const receipt = recorded('erc20-payment').rpc.eth_getTransactionReceipt as Record<
      string,
      string
    >;
    const paid =
      BigInt(receipt.gasUsed!) * BigInt(receipt.effectiveGasPrice!) + BigInt(receipt.l1Fee ?? 0);
    expect(view.fee).toMatchObject({ amount: paid.toString(), asset: ETH, payer: BASE_PAYOUTS });
    expect(view.value).toBeUndefined();
    expect(view.undecodedEvents).toBe(0);

    expect(decodeCall('base', baseInput('erc20-payment'), known)).toEqual({
      target: FLOW,
      decoded: true,
      decoder: 'erc20',
      function: 'transfer',
      selector: toFunctionSelector('transfer(address,uint256)'),
      args: [
        { name: 'to', type: 'address', value: BASE_REFUNDS },
        {
          name: 'amount',
          type: 'uint256',
          value: '1500000',
          asset: asset(FLOW, 'FLOW', 6),
          formatted: '1.5',
        },
      ],
    });
  });

  it('row 4: a call no decoder knows shows its selector and raw data, and its log counts as undecoded', async () => {
    const effects = await readRecorded('base-call-with-value');
    const view = decodeEffects(effects, known);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const call = decodeCall('base', baseInput('base-call-with-value'), known);

    expect(call).toEqual({
      target: VAULT,
      decoded: false,
      selector: toFunctionSelector('deposit(string)'),
      data: baseInput('base-call-with-value').data,
      value: { amount: '1000000000000', asset: ETH, formatted: '0.000001' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(view.value).toEqual({ amount: '1000000000000', asset: ETH, formatted: '0.000001' });
    expect(view.transfers).toEqual([
      {
        standard: 'native',
        token: 'native',
        from: BASE_PAYOUTS,
        to: VAULT,
        amount: '1000000000000',
        asset: ETH,
        formatted: '0.000001',
      },
    ]);
    expect(view.events).toEqual([]);
    expect(view.undecodedEvents).toBe(1);
    expect(view.undecodedEventSources).toEqual([{ source: VAULT, count: 1 }]);
  });

  it('row 7: a Bulk Call is aggregate3Value with each inner call decoded, and moves both payments', async () => {
    const effects = await readRecorded('bulk-call');

    expect(decodeCall('base', baseInput('bulk-call'), known)).toMatchObject({
      target: AGGREGATOR,
      decoded: true,
      decoder: 'multicall3',
      function: 'aggregate3Value',
      value: { amount: '1000000000000', formatted: '0.000001' },
      calls: [
        {
          target: FLOW,
          allowFailure: false,
          decoded: true,
          decoder: 'erc20',
          function: 'transfer',
          args: [
            { name: 'to', value: BASE_REFUNDS },
            { name: 'amount', value: '500000', formatted: '0.5' },
          ],
        },
        {
          target: BASE_REFUNDS,
          allowFailure: false,
          decoded: true,
          value: { amount: '1000000000000', formatted: '0.000001' },
        },
      ],
    });
    expect(decodeEffects(effects, known).transfers).toEqual([
      expect.objectContaining({ standard: 'native', from: BASE_PAYOUTS, to: AGGREGATOR }),
      expect.objectContaining({
        standard: 'erc20',
        token: FLOW,
        from: AGGREGATOR,
        to: BASE_REFUNDS,
        amount: '500000',
        formatted: '0.5',
      }),
    ]);
  });

  it('row 6: a Relay transaction is recorded too, its fee paid by the wallet that signed it', async () => {
    const view = decodeEffects(await readRecorded('base-relay'), known);

    expect(view.transfers).toEqual([
      expect.objectContaining({
        standard: 'native',
        from: BASE_RELAY,
        to: BASE_PAYOUTS,
        amount: '1000000000000',
      }),
    ]);
    expect(view.fee.payer).toBe(BASE_RELAY);
  });
});

describe('Solana effects and calls, from recorded transactions (ADR-0063)', () => {
  it('row 1: SPL and Token-2022 payments move 1.5 FSPL and 2.5 F22 between the wallets, and every instruction decodes', async () => {
    const view = decodeEffects(await readRecorded('spl-and-token-2022-payments'), known);

    expect(view.transfers).toEqual([
      {
        standard: 'spl',
        token: FSPL,
        from: SOL_PAYOUTS,
        to: SOL_REFUNDS,
        amount: '1500000',
        asset: asset(FSPL, 'FSPL', 6),
        formatted: '1.5',
      },
      {
        standard: 'token-2022',
        token: F22,
        from: SOL_PAYOUTS,
        to: SOL_REFUNDS,
        amount: '2500000',
        asset: asset(F22, 'F22', 6),
        formatted: '2.5',
      },
    ]);
    expect(view.events.map((e) => `${e.decoder}.${e.name}`)).toEqual(
      expect.arrayContaining([
        'associated-token-account.createIdempotent',
        'spl-token.transferChecked',
        'token-2022.transferChecked',
      ]),
    );
    expect(view.undecodedEvents).toBe(0);
    expect(view.fee).toMatchObject({ amount: '5000', asset: SOL, formatted: '0.000005' });
  });

  it('row 5: a Memo call and a raw SPL transferChecked decode, and the transfer shows in the effects', async () => {
    const effects = await readRecorded('memo-and-spl-call');
    const memo = decodeCall(
      'solana',
      {
        programId: MEMO_PROGRAM,
        accounts: [],
        data: Buffer.from('flows row 5').toString('base64'),
      },
      known,
      effects,
    );
    const instruction =
      effects.chain === 'solana'
        ? effects.instructions.find((ix) => ix.programId === TOKEN_PROGRAM)!
        : undefined;
    const transfer = decodeCall(
      'solana',
      {
        programId: TOKEN_PROGRAM,
        accounts: instruction!.accounts.map((pubkey) => ({
          pubkey,
          isSigner: false,
          isWritable: false,
        })),
        data: instruction!.data,
      },
      known,
      effects,
    );

    expect(memo).toEqual({
      target: MEMO_PROGRAM,
      decoded: true,
      decoder: 'memo',
      function: 'memo',
      args: [{ name: 'text', type: 'string', value: 'flows row 5' }],
    });
    expect(transfer).toMatchObject({
      decoded: true,
      decoder: 'spl-token',
      function: 'transferChecked',
      selector: '0c',
      args: [
        { name: 'source' },
        { name: 'mint', value: FSPL },
        { name: 'destination' },
        { name: 'authority', value: SOL_PAYOUTS },
        { name: 'amount', value: '250000', asset: asset(FSPL, 'FSPL', 6), formatted: '0.25' },
        { name: 'decimals', value: '6' },
      ],
    });
    expect(decodeEffects(effects, known).transfers).toEqual([
      expect.objectContaining({
        standard: 'spl',
        from: SOL_PAYOUTS,
        to: SOL_REFUNDS,
        amount: '250000',
        formatted: '0.25',
      }),
    ]);
  });

  it('row 6: a Relay transfer moves 0.001 SOL from the relay wallet, which pays the fee', async () => {
    const view = decodeEffects(await readRecorded('solana-relay'), known);

    expect(view.transfers).toEqual([
      {
        standard: 'native',
        token: 'native',
        from: SOL_RELAY,
        to: SOL_PAYOUTS,
        amount: '1000000',
        asset: SOL,
        formatted: '0.001',
      },
    ]);
    expect(view.fee.payer).toBe(SOL_RELAY);
  });

  it('shows a program no decoder knows by its program, an 8-byte discriminator and the raw data', () => {
    const data = Buffer.from([0xaf, 0xaf, 0x6d, 0x1f, 0x0d, 0x98, 0x9b, 0xed, 1, 2, 3]).toString(
      'base64',
    );
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    expect(
      decodeCall(
        'solana',
        { programId: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf', accounts: [], data },
        known,
      ),
    ).toEqual({
      target: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
      decoded: false,
      selector: 'afaf6d1f0d989bed',
      data,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('storage bounds (ADR-0063)', () => {
  it('keeps at most the bounded number of logs and cuts long data, and says so', () => {
    const log = {
      address: FLOW,
      topics: [],
      data: `0x${'ab'.repeat(EFFECTS_BOUNDS.dataBytes + 10)}`,
    };
    const effects = baseEffectsFrom(
      {
        blockNumber: '0x1',
        from: BASE_PAYOUTS,
        to: FLOW,
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        logs: Array.from({ length: EFFECTS_BOUNDS.entries + 5 }, () => log),
      },
      { value: '0x0', input: '0x' },
    );

    expect(effects.logs).toHaveLength(EFFECTS_BOUNDS.entries);
    expect(effects.logs[0]!.data).toHaveLength(2 + EFFECTS_BOUNDS.dataBytes * 2);
    expect(effects.truncated).toBe(true);
    expect(effects.fee).toBe('21000');
  });
});
