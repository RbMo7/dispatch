import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import type { DispatchStore } from './dispatch-store.js';

const item: DispatchItem<'solana'> = {
  call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' },
  payment: null,
};

/** ADR-0056: cancelling a Dispatch, run against both the fake and the real store so they agree. */
export function runCancelConformanceSuite(makeStore: () => DispatchStore): void {
  describe('cancelDispatch (ADR-0056)', () => {
    const newDispatch = (store: DispatchStore, idempotencyKey = randomUUID()) =>
      store.createDispatch({ chain: 'solana', idempotencyKey, items: [item], retryPolicy: false });

    it('cancels an unclaimed Dispatch, which the worker then never claims', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);

      expect(await store.cancelDispatch(dispatch.id)).toBe('cancelled');

      expect((await store.getDispatch(dispatch.id))?.status).toBe('cancelled');
      expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
    });

    it('answers a repeat cancel with cancelled, not an error', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);
      await store.cancelDispatch(dispatch.id);

      expect(await store.cancelDispatch(dispatch.id)).toBe('cancelled');
    });

    it('refuses a Dispatch the worker already claimed, leaving it claimed', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);
      await store.claimQueued(CHAINS, 10);

      expect(await store.cancelDispatch(dispatch.id)).toBe('already_claimed');
      expect((await store.getDispatch(dispatch.id))?.status).toBe('broadcasting');
    });

    it('cancels an unclaimed Relay Dispatch, which the worker then never claims', async () => {
      const store = makeStore();
      const relay = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        signedTransaction: 'signed',
      });

      expect(await store.cancelDispatch(relay.id)).toBe('cancelled');

      expect((await store.getRelayDispatch(relay.id))?.status).toBe('cancelled');
      expect(await store.claimQueuedRelayDispatches(CHAINS, 10)).toEqual([]);
    });

    it('refuses a claimed Relay Dispatch', async () => {
      const store = makeStore();
      const relay = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        signedTransaction: 'signed',
      });
      await store.claimQueuedRelayDispatches(CHAINS, 10);

      expect(await store.cancelDispatch(relay.id)).toBe('already_claimed');
    });

    it('reports an unknown id as not found', async () => {
      expect(await makeStore().cancelDispatch(randomUUID())).toBe('not_found');
    });

    it('returns the cancelled Dispatch for its Idempotency-Key, creating no new one', async () => {
      const store = makeStore();
      const key = randomUUID();
      const dispatch = await newDispatch(store, key);
      await store.cancelDispatch(dispatch.id);

      const again = await newDispatch(store, key);

      expect(again.id).toBe(dispatch.id);
      expect(again.status).toBe('cancelled');
      expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
    });
  });
}
