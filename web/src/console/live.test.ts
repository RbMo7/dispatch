import { describe, expect, it } from 'vitest';

import { nextDelay, retryDelay } from './live';

describe('polling cadence', () => {
  it('polls every 2 s while anything is in flight, then backs off to 30 s', () => {
    expect(nextDelay(true, 30_000)).toBe(2_000);
    const waits = [2_000];
    for (let i = 0; i < 5; i++) waits.push(nextDelay(false, waits.at(-1)!));
    expect(waits).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });

  it('retries a failed request after 2, 4, 8 … up to 30 s', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([
      2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });
});
