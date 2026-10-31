import { describe, expect, it } from 'vitest';

import type { DispatchStore, SignerKeyRecord } from './dispatch-store.js';

const pinned: SignerKeyRecord = {
  chain: 'base',
  address: '0xExecutor',
  read: {
    pins: { address: '0xexecutor', curve: 'secp256k1', chainIds: [84532], allowedSafe: '0xsafe' },
  },
  readAt: new Date('2026-11-01T10:00:00.000Z'),
};

export function runSignerKeyConformanceSuite(makeStore: () => DispatchStore): void {
  describe('signer keys (ADR-0059)', () => {
    it('has nothing for a key that was never read', async () => {
      const store = makeStore();

      expect(await store.getSignerKey('base', '0xNeverRead')).toBeNull();
    });

    it('reads back what was recorded', async () => {
      const store = makeStore();

      await store.recordSignerKey(pinned);

      expect(await store.getSignerKey('base', '0xExecutor')).toEqual(pinned);
    });

    it('keeps only the latest read of a key, however often it is recorded', async () => {
      const store = makeStore();
      const failed: SignerKeyRecord = {
        ...pinned,
        read: { error: 'the Signer could not be reached' },
        readAt: new Date('2026-11-01T10:05:00.000Z'),
      };
      const recovered: SignerKeyRecord = {
        ...pinned,
        readAt: new Date('2026-11-01T10:10:00.000Z'),
      };

      await store.recordSignerKey(pinned);
      await store.recordSignerKey(failed);
      expect(await store.getSignerKey('base', '0xExecutor')).toEqual(failed);

      await store.recordSignerKey(recovered);
      await store.recordSignerKey(recovered);
      expect(await store.getSignerKey('base', '0xExecutor')).toEqual(recovered);
    });

    it('keeps the same address on two chains apart', async () => {
      const store = makeStore();
      const onSolana: SignerKeyRecord = {
        ...pinned,
        chain: 'solana',
        read: { error: 'the Signer has no key for this address' },
      };

      await store.recordSignerKey(pinned);
      await store.recordSignerKey(onSolana);

      expect(await store.getSignerKey('base', '0xExecutor')).toEqual(pinned);
      expect(await store.getSignerKey('solana', '0xExecutor')).toEqual(onSolana);
    });
  });
}
