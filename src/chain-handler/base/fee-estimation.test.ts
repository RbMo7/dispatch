import { describe, expect, it } from 'vitest';

import { DEFAULT_PRIORITY_FEE_WEI, FEE_MULTIPLIER, estimateFeeFields } from './fee-estimation.js';

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
