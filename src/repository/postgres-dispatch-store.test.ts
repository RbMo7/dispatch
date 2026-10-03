import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../db/client.js';
import { attempts, dispatches, relayDispatches, transactions } from '../db/schema.js';
import type { DispatchItem, SolanaCall } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import { runChainScopeConformanceSuite } from './chain-scope-conformance.js';
import { PostgresDispatchStore } from './postgres-dispatch-store.js';

/**
 * ADR-0034: `PostgresDispatchStore` exercised against a real local Postgres
 * (a throwaway database on the `postgres` service, ADR-0047), not
 * `InMemoryDispatchStore` — proving the real schema, its constraints, and
 * Drizzle's own query mapping, none of which the rest of the suite ever
 * touches. Runs unconditionally, same as solana-chain-handler's devnet
 * tests: no reachable Postgres means this tier fails loudly,
 * not silently skips.
 */

const solanaCall: SolanaCall = { programId: 'prog', accounts: [], data: 'ZGF0YQ==' };
const solanaItem: DispatchItem<'solana'> = { call: solanaCall, payment: null };

async function truncateAll(): Promise<void> {
  await db.execute(
    sql`TRUNCATE TABLE ${attempts}, ${transactions}, ${relayDispatches}, ${dispatches} RESTART IDENTITY CASCADE`,
  );
}

describe('PostgresDispatchStore (real Postgres)', () => {
  let store: PostgresDispatchStore;

  beforeEach(async () => {
    store = new PostgresDispatchStore(db);
    await truncateAll();
  });

  runChainScopeConformanceSuite(() => new PostgresDispatchStore(db));

  describe('createDispatch', () => {
    it('persists a new Dispatch as queued', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });

      expect(dispatch.chain).toBe('solana');
      expect(dispatch.status).toBe('queued');
      expect(await store.getDispatch(dispatch.id)).toEqual(dispatch);
    });

    it('is idempotent via the real unique index on idempotency_key (ADR-0021)', async () => {
      const key = randomUUID();
      const first = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: key,
        items: [solanaItem],
        retryPolicy: false,
      });
      const second = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: key,
        items: [],
        retryPolicy: false,
      });

      expect(second).toEqual(first);
    });
  });

  describe('the dispatch_id polymorphism bug (core-engine-scaffold issue 14)', () => {
    it('createTransaction round-trips for a Managed Dispatch (dispatchId -> dispatches.id)', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });

      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-managed',
      });

      expect(transaction.dispatchId).toBe(dispatch.id);
      expect(await store.listTransactions(dispatch.id)).toEqual([transaction]);
    });

    it('createTransaction round-trips for a Relay Dispatch (dispatchId -> relay_dispatches.id, ADR-0031)', async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        signedTransaction: 'c2lnbmVk',
      });

      const transaction = await store.createTransaction({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-relay',
      });

      expect(transaction.dispatchId).toBe(relayDispatch.id);
      await store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);
      expect(await store.getRelayDispatch(relayDispatch.id)).toMatchObject({
        transactionId: transaction.id,
      });
    });

    it('recordCallFailure round-trips for a Managed Dispatch (dispatchId -> dispatches.id)', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });

      const failed = await store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        error: { code: 'INVALID_RECIPIENT', message: 'malformed recipient' },
      });

      expect(failed.status).toBe('FAILED');
      expect(failed.dispatchId).toBe(dispatch.id);
    });

    it('recordCallFailure round-trips for a Relay Dispatch (dispatchId -> relay_dispatches.id, ADR-0031)', async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        signedTransaction: 'c2lnbmVk',
      });

      const failed = await store.recordCallFailure({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: 'solana',
        error: { code: 'CHAIN_REJECTED', message: 'simulation failed' },
      });

      expect(failed.status).toBe('FAILED');
      expect(failed.dispatchId).toBe(relayDispatch.id);
    });
  });

  describe('claimQueued', () => {
    it('atomically claims queued Dispatches and flips them to broadcasting, via a real locking transaction', async () => {
      const a = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });
      const b = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });

      const claimed = await store.claimQueued(CHAINS, 10);

      expect(claimed.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
      expect(claimed.every((d) => d.status === 'broadcasting')).toBe(true);
      expect(await store.claimQueued(CHAINS, 10)).toEqual([]); // already claimed, not re-claimed
    });
  });

  describe('recordBroadcast', () => {
    it('inserts a real attempts row (FK to transactions.id) for a re-broadcast of identical bytes', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-1',
      });

      await store.recordBroadcast(transaction.id, 'hash-1');

      const rows = await db.query.attempts.findMany({
        where: (a, { eq }) => eq(a.transactionId, transaction.id),
      });
      expect(rows).toHaveLength(1);
    });

    it('rejects a re-broadcast whose hash differs from the Transaction it belongs to', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-1',
      });

      await expect(store.recordBroadcast(transaction.id, 'hash-2')).rejects.toThrow(
        /hash mismatch/,
      );
    });
  });

  describe('status transitions', () => {
    it('markConfirmed/markFailed/markAbandoned persist and read back through listTransactions', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem, solanaItem, solanaItem],
        retryPolicy: false,
      });
      const [confirmed, failed, abandoned] = await Promise.all([
        store.createTransaction({
          dispatchId: dispatch.id,
          callIndex: 0,
          chain: 'solana',
          signedBytes: 'c2lnbmVk',
          hash: 'hash-confirmed',
        }),
        store.createTransaction({
          dispatchId: dispatch.id,
          callIndex: 1,
          chain: 'solana',
          signedBytes: 'c2lnbmVk',
          hash: 'hash-failed',
        }),
        store.createTransaction({
          dispatchId: dispatch.id,
          callIndex: 2,
          chain: 'solana',
          signedBytes: 'c2lnbmVk',
          hash: 'hash-abandoned',
        }),
      ]);

      await store.markConfirmed(confirmed.id);
      await store.markFailed(failed.id, { code: 'CHAIN_REJECTED', message: 'reverted' });
      await store.markAbandoned(abandoned.id);

      const rows = await store.listTransactions(dispatch.id);
      const confirmedRow = rows.find((r) => r.id === confirmed.id);
      expect(confirmedRow?.status).toBe('CONFIRMED');
      expect(confirmedRow?.confirmedAt).toBeInstanceOf(Date);
      const failedRow = rows.find((r) => r.id === failed.id);
      expect(failedRow?.status).toBe('FAILED');
      expect(failedRow?.error).toEqual({ code: 'CHAIN_REJECTED', message: 'reverted' });
      const abandonedRow = rows.find((r) => r.id === abandoned.id);
      expect(abandonedRow?.status).toBe('ABANDONED');
      expect(abandonedRow?.abandonedAt).toBeInstanceOf(Date);
    });

    it('reopenTransaction resets a CONFIRMED row back to PENDING, clearing confirmedAt (base-chain-handler issue 07)', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-reopen',
      });
      await store.markConfirmed(transaction.id);

      await store.reopenTransaction(transaction.id);

      const [row] = await store.listTransactions(dispatch.id);
      expect(row?.status).toBe('PENDING');
      expect(row?.confirmedAt).toBeNull();
    });
  });

  describe('fee-bump bookkeeping (#9)', () => {
    let hashOriginal = '';
    async function createOriginal() {
      hashOriginal = `hash-original-${randomUUID()}`;
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: true,
      });
      return store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'b3JpZ2luYWw=',
        hash: hashOriginal,
      });
    }

    it('creates a replacement for the same Call and marks the predecessor REPLACED', async () => {
      const original = await createOriginal();

      const hashBumped = `hash-bumped-${randomUUID()}`;
      const replacement = await store.createReplacementTransaction(original.id, {
        signedBytes: 'YnVtcGVk',
        hash: hashBumped,
      });

      expect(replacement).toMatchObject({
        dispatchId: original.dispatchId,
        callIndex: 0,
        chain: 'solana',
        status: 'PENDING',
        hash: hashBumped,
        replacesTransactionId: original.id,
        feeBumpAttempts: 1,
      });
      expect(replacement.lastBroadcastAt).not.toBeNull();
      const all = await store.listTransactions(original.dispatchId);
      expect(all.find((t) => t.id === original.id)?.status).toBe('REPLACED');
    });

    it('lists every Transaction sharing a hash', async () => {
      const original = await createOriginal();
      const byHash = await store.listTransactionsByHash(hashOriginal);
      expect(byHash.map((t) => t.id)).toEqual([original.id]);
    });

    it('records fee-bump attempts and drops a version', async () => {
      const original = await createOriginal();
      await store.setFeeBumpAttempts(original.id, 3);
      await store.markDropped(original.id);

      const [row] = await store.listTransactionsByHash(hashOriginal);
      expect(row?.feeBumpAttempts).toBe(3);
      expect(row?.status).toBe('DROPPED');
    });

    it('stamps lastBroadcastAt on first broadcast and again on a rebroadcast Attempt', async () => {
      const original = await createOriginal();
      expect(original.lastBroadcastAt).not.toBeNull();
      await store.recordBroadcast(original.id, hashOriginal);
      const [row] = await store.listTransactionsByHash(hashOriginal);
      expect(row!.lastBroadcastAt!.getTime()).toBeGreaterThanOrEqual(
        original.lastBroadcastAt!.getTime(),
      );
    });
  });

  describe('bulkCall (#11)', () => {
    it("round-trips a Dispatch's bulkCall and each item's fundedBy", async () => {
      const created = await store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        items: [
          { call: { to: '0xabc', data: '0x', value: '1' }, payment: null },
          {
            call: { to: '0xtoken', data: '0xa9059cbb', value: '0' },
            payment: null,
            fundedBy: '0xaggregator',
          },
        ],
        retryPolicy: false,
        bulkCall: { aggregator: '0xaggregator', maxBatchSize: 2, allowFailure: false },
      });

      const read = await store.getDispatch(created.id);

      expect(read?.bulkCall).toEqual({
        aggregator: '0xaggregator',
        maxBatchSize: 2,
        allowFailure: false,
      });
      expect(read?.items.map((i) => i.fundedBy ?? null)).toEqual([null, '0xaggregator']);
    });

    it('defaults bulkCall to null', async () => {
      const created = await store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID() + '-plain',
        items: [{ call: { to: '0xabc', data: '0x', value: '1' }, payment: null }],
        retryPolicy: false,
      });
      expect((await store.getDispatch(created.id))?.bulkCall).toBeNull();
    });
  });

  describe('write-ahead bookkeeping (#20, ADR-0041)', () => {
    async function pending(hash: string) {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: true,
      });
      return store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash,
      });
    }

    it('recordSent stamps lastBroadcastAt and takes the hash the chain actually reported', async () => {
      const noted = await pending(`h-noted-${Math.random()}`);
      const reported = `h-reported-${Math.random()}`;

      await store.recordSent(noted.id, reported);

      const [row] = await store.listTransactionsByHash(reported);
      expect(row?.id).toBe(noted.id);
      expect(row?.status).toBe('PENDING');
      expect(row?.lastBroadcastAt).not.toBeNull();
    });

    it('undoReplacement drops a refused replacement and puts its predecessor back to PENDING', async () => {
      const original = await pending(`h-orig-${Math.random()}`);
      const replacement = await store.createReplacementTransaction(original.id, {
        signedBytes: 'YnVtcGVk',
        hash: `h-bump-${Math.random()}`,
      });

      await store.undoReplacement(replacement.id);

      const rows = await store.listTransactions(original.dispatchId);
      expect(rows.find((t) => t.id === original.id)?.status).toBe('PENDING');
      expect(rows.find((t) => t.id === replacement.id)?.status).toBe('DROPPED');
    });

    it('reclaims a Dispatch claimed before the cutoff that still has items with no Transaction, and only once', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });
      await store.claimQueued(CHAINS, 100);
      await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: `h-${Math.random()}`,
      });

      const future = new Date(Date.now() + 60_000);
      const reclaimed = await store.reclaimStaleDispatches(CHAINS, future, 100);
      const again = await store.reclaimStaleDispatches(CHAINS, new Date(Date.now() - 60_000), 100);

      expect(reclaimed.map((d) => d.id)).toContain(dispatch.id);
      expect(again.map((d) => d.id)).not.toContain(dispatch.id); // re-stamped: not stale again yet
    });

    it('never reclaims a Dispatch whose items all have Transactions', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });
      await store.claimQueued(CHAINS, 100);
      await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: `h-${Math.random()}`,
      });

      const reclaimed = await store.reclaimStaleDispatches(
        CHAINS,
        new Date(Date.now() + 60_000),
        100,
      );

      expect(reclaimed.map((d) => d.id)).not.toContain(dispatch.id);
    });

    it('reclaims a Relay Dispatch claimed before the cutoff that never got a Transaction', async () => {
      const relay = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        signedTransaction: 'c2lnbmVk',
      });
      await store.claimQueuedRelayDispatches(CHAINS, 100);

      const reclaimed = await store.reclaimStaleRelayDispatches(
        CHAINS,
        new Date(Date.now() + 60_000),
        100,
      );

      expect(reclaimed.map((r) => r.id)).toContain(relay.id);
    });
  });

  describe('listPendingTransactions', () => {
    it('rotates through every pending row, so long-pending rows never starve newer ones (#21)', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem, solanaItem, solanaItem],
        retryPolicy: false,
      });
      const ids: string[] = [];
      for (const callIndex of [0, 1, 2]) {
        const transaction = await store.createTransaction({
          dispatchId: dispatch.id,
          callIndex,
          chain: 'solana',
          signedBytes: 'c2lnbmVk',
          hash: `hash-rotate-${callIndex}`,
        });
        ids.push(transaction.id);
      }

      const firstTick = await store.listPendingTransactions(CHAINS, 2);
      const secondTick = await store.listPendingTransactions(CHAINS, 2);

      expect(firstTick.map((t) => t.id)).toEqual([ids[0], ids[1]]);
      expect(secondTick.map((t) => t.id)[0]).toBe(ids[2]);
    });
  });

  describe('listRecentlyConfirmedTransactions', () => {
    it('returns only CONFIRMED transactions whose confirmedAt is no earlier than notConfirmedBefore', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });
      const pending = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-pending',
      });
      const confirmed = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'hash-confirmed-recent',
      });
      await store.markConfirmed(confirmed.id);

      const result = await store.listRecentlyConfirmedTransactions('solana', 10, new Date(0));

      expect(result.map((t) => t.id)).toContain(confirmed.id);
      expect(result.map((t) => t.id)).not.toContain(pending.id);
    });
  });
});
