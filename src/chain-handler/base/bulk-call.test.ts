import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AGGREGATE3_VALUE_ABI,
  chunk,
  encodeAggregate3Value,
  slotsFromTrace,
} from './bulk-call.js';

const target = '0x000000000000000000000000000000000000dEaD';

describe('encodeAggregate3Value (#11)', () => {
  it('encodes every item with allowFailure: true, in order, and totals the native value', () => {
    const { data, value } = encodeAggregate3Value([
      { to: target, data: '0x', value: '5' },
      { to: target, data: '0xa9059cbb', value: '0' },
      { to: target, data: '0x', value: '7' },
    ]);

    const decoded = decodeFunctionData({ abi: AGGREGATE3_VALUE_ABI, data });
    expect(decoded.args[0].map((c) => [c.allowFailure, c.value, c.callData])).toEqual([
      [true, 5n, '0x'],
      [true, 0n, '0xa9059cbb'],
      [true, 7n, '0x'],
    ]);
    expect(value).toBe(12n);
  });
});

describe('chunk (#11)', () => {
  it('splits into maxBatchSize-sized chunks, keeping order, never dropping the remainder', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('slotsFromTrace (#11, review: decode the Result[] output, not sub-call frames)', () => {
  const output = (results: { success: boolean; returnData: `0x${string}` }[]) =>
    encodeFunctionResult({
      abi: AGGREGATE3_VALUE_ABI,
      functionName: 'aggregate3Value',
      result: results,
    });

  it("reads each slot's own outcome from the aggregator's Result[] return data", () => {
    const slots = slotsFromTrace(
      {
        type: 'CALL',
        to: target,
        output: output([
          { success: true, returnData: '0x' },
          { success: false, returnData: '0x08c379a0' },
          { success: true, returnData: '0x01' },
        ]),
      },
      3,
    );

    expect(slots).toEqual({
      ok: true,
      value: [
        { status: 'CONFIRMED' },
        { status: 'FAILED', detail: { revert: '0x08c379a0' } },
        { status: 'CONFIRMED' },
      ],
    });
  });

  it('is unaffected by extra or proxied frames under the aggregator (e.g. a DELEGATECALL to an implementation)', () => {
    const slots = slotsFromTrace(
      {
        type: 'CALL',
        to: target,
        output: output([{ success: true, returnData: '0x' }]),
        calls: [
          { type: 'DELEGATECALL', to: target, calls: [{ type: 'STATICCALL' }, { type: 'CALL' }] },
        ],
      },
      1,
    );

    expect(slots.ok && slots.value).toEqual([{ status: 'CONFIRMED' }]);
  });

  it('fails every slot when the aggregator call itself reverted', () => {
    const slots = slotsFromTrace({ type: 'CALL', to: target, error: 'execution reverted' }, 2);

    expect(slots.ok && slots.value.map((s) => s.status)).toEqual(['FAILED', 'FAILED']);
  });

  it('answers a structured error for output that is not a Result[] of the expected length', () => {
    expect(slotsFromTrace({ type: 'CALL', to: target, output: '0x' }, 1).ok).toBe(false);
    expect(
      slotsFromTrace(
        { type: 'CALL', to: target, output: output([{ success: true, returnData: '0x' }]) },
        2,
      ).ok,
    ).toBe(false);
  });
});
