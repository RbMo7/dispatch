import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../db/client.js';
import { attempts, dispatches, relayDispatches, transactions } from '../db/schema.js';
import type { DispatchItem, SolanaCall } from '../domain/call.js';
import { PostgresDispatchStore } from './postgres-dispatch-store.js';

/**
 * ADR-0034: `PostgresDispatchStore` exercised against a real local Postgres
 * (the `postgres` service in docker-compose.yml, migrated), not
 * `InMemoryDispatchStore` — proving the real schema, its constraints, and
 * Drizzle's own query mapping, none of which the rest of the suite ever
 * touches. Runs unconditionally, same as solana-chain-handler's devnet
 * tests: no reachable, migrated Postgres means this tier fails loudly,
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

      const claimed = await store.claimQueued(10);

      expect(claimed.map((d) => d.id).sort()).toEqual([a.id, b.id].sort());
      expect(claimed.every((d) => d.status === 'broadcasting')).toBe(true);
      expect(await store.claimQueued(10)).toEqual([]); // already claimed, not re-claimed
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

      await expect(store.recordBroadcast(transaction.id, 'hash-2')).rejects.toThrow(/hash mismatch/);
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
