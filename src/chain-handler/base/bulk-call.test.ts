import { decodeFunctionData } from 'viem';
import { describe, expect, it } from 'vitest';

import {
  AGGREGATE3_VALUE_ABI,
  chunk,
  encodeAggregate3Value,
  slotsFromTrace,
  type CallTrace,
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

describe('slotsFromTrace (#11)', () => {
  const call = (error?: string): CallTrace => ({
    type: 'CALL',
    to: target,
    ...(error ? { error, output: '0x08c379a0' } : {}),
  });

  it("reads each slot's own outcome from the aggregator's direct sub-calls", () => {
    const slots = slotsFromTrace(
      { type: 'CALL', to: target, calls: [call(), call('execution reverted'), call()] },
      3,
    );

    expect(slots).toEqual({
      ok: true,
      value: [
        { status: 'CONFIRMED' },
        { status: 'FAILED', detail: { error: 'execution reverted', revert: '0x08c379a0' } },
        { status: 'CONFIRMED' },
      ],
    });
  });

  it('fails every slot when the aggregator call itself reverted', () => {
    const slots = slotsFromTrace(
      { type: 'CALL', to: target, error: 'execution reverted', calls: [call()] },
      2,
    );

    expect(slots.ok && slots.value.map((s) => s.status)).toEqual(['FAILED', 'FAILED']);
  });

  it('answers a structured error when the trace has a different number of sub-calls than the bundle has items', () => {
    const slots = slotsFromTrace({ type: 'CALL', to: target, calls: [call()] }, 2);

    expect(slots.ok).toBe(false);
  });
});
