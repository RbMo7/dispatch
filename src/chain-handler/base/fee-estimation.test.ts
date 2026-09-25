import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PRIORITY_FEE_WEI,
  FEE_MULTIPLIER,
  bumpFeeFields,
  estimateFeeFields,
} from './fee-estimation.js';

describe('estimateFeeFields', () => {
  it('sets maxFeePerGas to a fixed multiplier over the given baseFeePerGas', () => {
    const fields = estimateFeeFields(1_000_000n);
    expect(fields.maxFeePerGas).toBe(1_000_000n * FEE_MULTIPLIER);
  });

  it('sets maxPriorityFeePerGas to the documented fixed tip, independent of baseFeePerGas', () => {
    expect(estimateFeeFields(1_000_000n).maxPriorityFeePerGas).toBe(DEFAULT_PRIORITY_FEE_WEI);
    expect(estimateFeeFields(999_999_999n).maxPriorityFeePerGas).toBe(DEFAULT_PRIORITY_FEE_WEI);
  });

  it('scales with baseFeePerGas', () => {
    const low = estimateFeeFields(1_000n);
    const high = estimateFeeFields(2_000n);
    expect(high.maxFeePerGas).toBe(low.maxFeePerGas * 2n);
  });
});

describe('bumpFeeFields (#9)', () => {
  const previous = { maxFeePerGas: 1_000n, maxPriorityFeePerGas: 100n };

  it('raises both fields by at least the bump percentage, rounding up, when the fresh estimate is lower', () => {
    const bumped = bumpFeeFields(previous, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, 15);
    expect(bumped).toEqual({ maxFeePerGas: 1_150n, maxPriorityFeePerGas: 115n });
  });

  it('rounds a fractional bump up, never down below the replacement minimum', () => {
    const bumped = bumpFeeFields(
      { maxFeePerGas: 7n, maxPriorityFeePerGas: 3n },
      { maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      10,
    );
    expect(bumped).toEqual({ maxFeePerGas: 8n, maxPriorityFeePerGas: 4n });
  });

  it('catches up to the fresh estimate per field when it is higher than the percentage bump', () => {
    const bumped = bumpFeeFields(previous, { maxFeePerGas: 5_000n, maxPriorityFeePerGas: 50n }, 15);
    expect(bumped).toEqual({ maxFeePerGas: 5_000n, maxPriorityFeePerGas: 115n });
  });

  it('never lets maxPriorityFeePerGas exceed maxFeePerGas', () => {
    const bumped = bumpFeeFields(
      { maxFeePerGas: 100n, maxPriorityFeePerGas: 100n },
      { maxFeePerGas: 0n, maxPriorityFeePerGas: 500n },
      10,
    );
    expect(bumped.maxPriorityFeePerGas <= bumped.maxFeePerGas).toBe(true);
    expect(bumped.maxFeePerGas).toBe(500n);
  });
});
