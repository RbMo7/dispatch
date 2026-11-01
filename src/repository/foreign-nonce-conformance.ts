import { describe, expect, it } from 'vitest';

import type { SenderAddress, SenderRef } from '../domain/sender.js';
import type { DispatchStore } from './dispatch-store.js';

const PAYOUTS: SenderRef = {
  chain: 'base',
  address: '0x1111111111111111111111111111111111111111' as SenderAddress,
};
const REFUNDS: SenderRef = {
  chain: 'base',
  address: '0x2222222222222222222222222222222222222222' as SenderAddress,
};

/** ADR-0064 (#172): nonces another sender used, the same on every DispatchStore. */
export function runForeignNonceConformanceSuite(makeStore: () => DispatchStore): void {
  describe('foreign nonces (ADR-0064)', () => {
    it('records each nonce once and returns only the new ones', async () => {
      const store = makeStore();
      const first = new Date('2026-11-01T10:00:00Z');
      const later = new Date('2026-11-01T10:05:00Z');

      expect(await store.recordForeignNonces(PAYOUTS, [7, 5, 6], first)).toEqual([5, 6, 7]);
      expect(await store.recordForeignNonces(PAYOUTS, [6, 7, 9], later)).toEqual([9]);
      expect(await store.recordForeignNonces(PAYOUTS, [], later)).toEqual([]);

      expect(await store.foreignActivity(PAYOUTS, first)).toEqual({
        lastSeenAt: later,
        nonces: [5, 9],
        count: 4,
      });
    });

    it('counts only what was first seen in the window, per Sender', async () => {
      const store = makeStore();
      await store.recordForeignNonces(PAYOUTS, [1, 2], new Date('2026-11-01T08:00:00Z'));
      await store.recordForeignNonces(PAYOUTS, [10], new Date('2026-11-01T12:00:00Z'));
      await store.recordForeignNonces(REFUNDS, [3], new Date('2026-11-01T12:00:00Z'));

      expect(await store.foreignActivity(PAYOUTS, new Date('2026-11-01T11:00:00Z'))).toEqual({
        lastSeenAt: new Date('2026-11-01T12:00:00Z'),
        nonces: [10, 10],
        count: 1,
      });
      expect(await store.foreignActivity(REFUNDS, new Date('2026-11-01T13:00:00Z'))).toBeNull();
      expect(
        await store.foreignActivity({ chain: 'solana', address: PAYOUTS.address }, new Date(0)),
      ).toBeNull();
    });
  });
}
