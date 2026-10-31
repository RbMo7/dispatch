import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { listDispatchPage, parseListQuery } from '../api/dispatch-list.js';
import type { DispatchItem } from '../domain/call.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import type { DispatchListQuery, DispatchStore } from './dispatch-store.js';

const items: { [C in Chain]: DispatchItem<C> } = {
  base: { call: { to: '0xabc', data: '0x', value: '0' }, payment: null },
  solana: { call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' }, payment: null },
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

function newManaged(store: DispatchStore, chain: Chain = 'base') {
  return chain === 'base'
    ? store.createDispatch({
        chain,
        idempotencyKey: randomUUID(),
        items: [items.base],
        retryPolicy: false,
      })
    : store.createDispatch({
        chain,
        idempotencyKey: randomUUID(),
        items: [items.solana],
        retryPolicy: false,
      });
}

function newRelay(store: DispatchStore, chain: Chain = 'base') {
  return store.createRelayDispatch({
    chain,
    idempotencyKey: randomUUID(),
    signedTransaction: 'signed',
  });
}

async function listAll(
  store: DispatchStore,
  query: Omit<DispatchListQuery, 'after'>,
  betweenPages?: () => Promise<unknown>,
) {
  const ids: string[] = [];
  let after: DispatchListQuery['after'] = null;
  for (;;) {
    const page = await store.listDispatches({ ...query, after });
    ids.push(...page.map((l) => l.dispatch.id));
    const last = page.at(-1);
    if (!last || page.length < query.limit) return ids;
    after = last.cursor;
    await betweenPages?.();
  }
}

export function runListConformanceSuite(makeStore: () => DispatchStore): void {
  describe('listDispatches (#110)', () => {
    it('pages Managed and Relay Dispatches newest first, skipping and repeating nothing while new ones arrive', async () => {
      const store = makeStore();
      const created: string[] = [];
      for (let i = 0; i < 7; i++) {
        created.push((i % 3 === 0 ? await newRelay(store) : await newManaged(store)).id);
        await tick();
      }

      const listed = await listAll(store, { limit: 2 }, async () => {
        await tick();
        await newManaged(store);
      });

      expect(listed).toEqual([...created].reverse());
    });

    it('pages a burst created within the same millisecond without skipping or repeating a row', async () => {
      const store = makeStore();
      const created = await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? newRelay(store) : newManaged(store))),
      );

      const listed = await listAll(store, { limit: 1 });

      expect(listed).toHaveLength(created.length);
      expect([...listed].sort()).toEqual(created.map((d) => d.id).sort());
    });

    it('filters on chain, mode, stored status and creation time', async () => {
      const store = makeStore();
      const early = await newManaged(store, 'base');
      await tick();
      const from = new Date();
      await tick();
      const solana = await newManaged(store, 'solana');
      const relay = await newRelay(store, 'base');
      const cancelled = await newManaged(store, 'base');
      await store.cancelDispatch(cancelled.id);
      await tick();
      const to = new Date();
      await tick();
      const late = await newManaged(store, 'base');

      expect(await listAll(store, { limit: 10, chain: 'solana' })).toEqual([solana.id]);
      expect(await listAll(store, { limit: 10, mode: 'relay' })).toEqual([relay.id]);
      expect(await listAll(store, { limit: 10, storedStatuses: ['cancelled'] })).toEqual([
        cancelled.id,
      ]);
      expect((await listAll(store, { limit: 10, from, to })).sort()).toEqual(
        [solana.id, relay.id, cancelled.id].sort(),
      );
      expect(await listAll(store, { limit: 10, to: from })).toEqual([early.id]);
      expect(await listAll(store, { limit: 10, from: to })).toEqual([late.id]);
    });

    it('lists each row with every one of its Transactions', async () => {
      const store = makeStore();
      const dispatch = await newManaged(store);
      await store.claimQueued(CHAINS, 10);
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: 'b',
        hash: 'h',
      });

      const [listed] = await store.listDispatches({ after: null, limit: 10 });

      expect(listed?.transactions.map((t) => t.id)).toEqual([transaction.id]);
    });

    it('filters on a derived status across pages, with only the last page short', async () => {
      const store = makeStore();
      const settle = async (outcomes: ('confirmed' | 'failed')[]) => {
        const dispatch = await store.createDispatch({
          chain: 'base',
          idempotencyKey: randomUUID(),
          items: outcomes.map(() => items.base),
          retryPolicy: false,
        });
        await tick();
        await store.claimQueued(CHAINS, 10);
        for (const [callIndex, outcome] of outcomes.entries()) {
          const t = await store.createTransaction({
            dispatchId: dispatch.id,
            callIndex,
            chain: 'base',
            signedBytes: 'b',
            hash: `h-${randomUUID()}`,
          });
          if (outcome === 'confirmed') await store.markConfirmed(t.id);
          else await store.markFailed(t.id, { code: 'CHAIN_REJECTED', message: 'reverted' });
        }
        return dispatch.id;
      };
      const confirmed: string[] = [];
      for (let i = 0; i < 5; i++) {
        confirmed.push(await settle(['confirmed']));
        await settle(['failed']);
        await settle(['confirmed', 'failed']);
        await newManaged(store);
        await tick();
      }

      const pages: string[][] = [];
      let cursor: string | undefined;
      for (;;) {
        const filter = parseListQuery({
          limit: 2,
          status: 'confirmed',
          ...(cursor ? { cursor } : {}),
        });
        if (!filter.ok) throw new Error(filter.error);
        const page = await listDispatchPage(store, filter.value, () => undefined);
        pages.push(page.dispatches.map((d) => d.dispatchId));
        expect(page.dispatches.every((d) => d.status === 'confirmed')).toBe(true);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }

      expect(pages.map((p) => p.length)).toEqual([2, 2, 1]);
      expect(pages.flat()).toEqual([...confirmed].reverse());
    });
  });
}
