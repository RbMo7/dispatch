import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import type { OperatorActor } from '../domain/operator-action.js';
import type { DispatchStore } from './dispatch-store.js';

const item: DispatchItem<'solana'> = {
  call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' },
  payment: null,
};

const byClient: OperatorActor = { tokenKind: 'auth', reason: null };

async function actionsOn(store: DispatchStore, targetId: string) {
  const listed = await store.listOperatorActions({ after: null, limit: 100 });
  return listed.map((l) => l.action).filter((a) => a.targetId === targetId);
}

export function runCancelConformanceSuite(makeStore: () => DispatchStore): void {
  describe('cancelDispatch (ADR-0056)', () => {
    const newDispatch = (store: DispatchStore, idempotencyKey = randomUUID()) =>
      store.createDispatch({ chain: 'solana', idempotencyKey, items: [item], retryPolicy: false });

    it('cancels an unclaimed Dispatch, which the worker then never claims', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);

      expect(await store.cancelDispatch(dispatch.id, byClient)).toBe('cancelled');

      expect((await store.getDispatch(dispatch.id))?.status).toBe('cancelled');
      expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
    });

    it('records exactly one operator action per cancel, and none for a repeat (ADR-0057)', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);

      await store.cancelDispatch(dispatch.id, { tokenKind: 'operator', reason: 'wrong file' });
      expect(await store.cancelDispatch(dispatch.id, byClient)).toBe('already_cancelled');

      expect(await actionsOn(store, dispatch.id)).toEqual([
        {
          id: expect.any(String) as string,
          at: expect.any(Date) as Date,
          action: 'cancel',
          targetId: dispatch.id,
          tokenKind: 'operator',
          reason: 'wrong file',
        },
      ]);
    });

    it('records nothing for a refused cancel', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);
      await store.claimQueued(CHAINS, 10);

      await store.cancelDispatch(dispatch.id, byClient);

      expect(await actionsOn(store, dispatch.id)).toEqual([]);
    });

    it('refuses a Dispatch the worker already claimed, leaving it claimed', async () => {
      const store = makeStore();
      const dispatch = await newDispatch(store);
      await store.claimQueued(CHAINS, 10);

      expect(await store.cancelDispatch(dispatch.id, byClient)).toBe('already_claimed');
      expect((await store.getDispatch(dispatch.id))?.status).toBe('broadcasting');
    });

    it('cancels an unclaimed Relay Dispatch, which the worker then never claims', async () => {
      const store = makeStore();
      const relay = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        signedTransaction: 'signed',
      });

      expect(await store.cancelDispatch(relay.id, byClient)).toBe('cancelled');

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

      expect(await store.cancelDispatch(relay.id, byClient)).toBe('already_claimed');
    });

    it('reports an unknown id as not found', async () => {
      expect(await makeStore().cancelDispatch(randomUUID(), byClient)).toBe('not_found');
    });

    it('returns the cancelled Dispatch for its Idempotency-Key, creating no new one', async () => {
      const store = makeStore();
      const key = randomUUID();
      const dispatch = await newDispatch(store, key);
      await store.cancelDispatch(dispatch.id, byClient);

      const again = await newDispatch(store, key);

      expect(again.id).toBe(dispatch.id);
      expect(again.status).toBe('cancelled');
      expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
    });
  });
}
