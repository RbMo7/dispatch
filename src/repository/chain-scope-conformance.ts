import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import type { DispatchStore } from './dispatch-store.js';

const items: { [C in Chain]: DispatchItem<C> } = {
  base: { call: { to: '0xabc', data: '0x', value: '0' }, payment: null },
  solana: { call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' }, payment: null },
};

/** One row in every work queue for `chain`. */
async function seedWork(store: DispatchStore, chain: Chain) {
  const key = (name: string) => `${chain}-${name}-${Math.random()}`;
  const item = items[chain];
  const stale = await store.createDispatch({
    chain,
    idempotencyKey: key('stale'),
    items: [item, item],
    retryPolicy: false,
  });
  const settled = await store.createDispatch({
    chain,
    idempotencyKey: key('settled'),
    items: [item],
    retryPolicy: false,
  });
  const staleRelay = await store.createRelayDispatch({
    chain,
    idempotencyKey: key('stale-relay'),
    signedTransaction: `${chain}-signed`,
  });
  return { stale, settled, staleRelay };
}

/**
 * #57: every DispatchStore work queue returns rows only for the chains it is
 * asked for, and leaves every other chain's rows exactly as they were. Run
 * against both the fake and the real store so they can't drift apart.
 */
export function runChainScopeConformanceSuite(makeStore: () => DispatchStore): void {
  describe('chain scope (#57)', () => {
    it('never loads or changes work for a chain outside the requested ones', async () => {
      const store = makeStore();
      const seeded = {
        base: await seedWork(store, 'base'),
        solana: await seedWork(store, 'solana'),
      };
      await store.claimQueued(CHAINS, 100);
      await store.claimQueuedRelayDispatches(CHAINS, 100);

      const seedRest = async (chain: Chain) => {
        const { stale, settled, staleRelay } = seeded[chain];
        const pending = await store.createTransaction({
          dispatchId: stale.id,
          callIndex: 0,
          chain,
          signedBytes: `${chain}-pending`,
          hash: `${chain}-pending`,
        });
        const abandoned = await store.createTransaction({
          dispatchId: settled.id,
          callIndex: 0,
          chain,
          signedBytes: `${chain}-abandoned`,
          hash: `${chain}-abandoned`,
        });
        await store.markAbandoned(abandoned.id);
        const queued = await store.createDispatch({
          chain,
          idempotencyKey: `${chain}-queued-${Math.random()}`,
          items: [items[chain]],
          retryPolicy: false,
        });
        const queuedRelay = await store.createRelayDispatch({
          chain,
          idempotencyKey: `${chain}-queued-relay-${Math.random()}`,
          signedTransaction: `${chain}-signed`,
        });
        return {
          stale: stale.id,
          staleRelay: staleRelay.id,
          pending: pending.id,
          abandoned: abandoned.id,
          queued: queued.id,
          queuedRelay: queuedRelay.id,
        };
      };
      const work = { base: await seedRest('base'), solana: await seedRest('solana') };
      const ids = (rows: { id: string }[]) => rows.map((row) => row.id);
      const later = new Date(Date.now() + 60_000);

      expect(await store.countWaitingWork(['solana'])).toEqual(new Map([['solana', 3]]));
      expect(ids(await store.reclaimStaleDispatches(['base'], later, 100))).toEqual([
        work.base.stale,
      ]);
      expect(ids(await store.reclaimStaleRelayDispatches(['base'], later, 100))).toEqual([
        work.base.staleRelay,
      ]);
      expect(ids(await store.listPendingTransactions(['base'], 100))).toEqual([work.base.pending]);
      expect(ids(await store.listAbandonedTransactions(['base'], 100, new Date(0)))).toEqual([
        work.base.abandoned,
      ]);
      expect(ids(await store.claimQueued(['base'], 100))).toEqual([work.base.queued]);
      expect(ids(await store.claimQueuedRelayDispatches(['base'], 100))).toEqual([
        work.base.queuedRelay,
      ]);

      expect((await store.getDispatch(work.solana.queued))?.status).toBe('queued');
      expect((await store.getRelayDispatch(work.solana.queuedRelay))?.status).toBe('queued');
      const solanaPending = (await store.listTransactions(work.solana.stale)).find(
        (t) => t.id === work.solana.pending,
      );
      expect(solanaPending).toMatchObject({ status: 'PENDING', lastCheckedAt: null });
    });
  });
}
