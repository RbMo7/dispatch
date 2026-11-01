import { describe, expect, it } from 'vitest';

import { DISPATCHES } from './fixtures';

describe('gallery fixtures', () => {
  it.each(DISPATCHES.map((d) => [d.label, d] as const))(
    '%s is internally consistent',
    (_, dispatch) => {
      expect(dispatch.items).toHaveLength(dispatch.itemCount);
      const sum = dispatch.items.reduce(
        (total, item) => total + BigInt(item.amount?.raw ?? '0'),
        0n,
      );
      expect(sum.toString()).toBe(dispatch.totals[0]!.raw);
      for (const item of dispatch.items) {
        if (item.status === 'failed') expect(item.error).not.toBeNull();
      }
    },
  );

  it('has the 1,000-item Dispatch match the counts its flow reports', () => {
    const large = DISPATCHES.find((d) => d.itemCount === 1000)!;
    const tally = (status: string) => large.items.filter((item) => item.status === status).length;
    expect([tally('confirmed'), tally('broadcasting'), tally('failed'), tally('queued')]).toEqual([
      612, 25, 3, 360,
    ]);
    const counts = large
      .flowFor(() => {})
      .stages.flatMap((stage) => (stage.count ? [stage.count.reached] : []));
    expect(counts).toEqual([612 + 25 + 3, 612]);
  });
});
