import { beforeEach, describe, expect, it } from 'vitest';

import type { DispatchItem, SolanaCall } from '../domain/call.js';
import { InMemoryDispatchStore } from './in-memory-dispatch-store.js';

const solanaCall: SolanaCall = { programId: 'prog', accounts: [], data: 'ZGF0YQ==' };
const solanaItem: DispatchItem<'solana'> = { call: solanaCall, payment: null };

describe('InMemoryDispatchStore', () => {
  let store: InMemoryDispatchStore;

  beforeEach(() => {
    store = new InMemoryDispatchStore();
  });

  describe('createDispatch', () => {
    it('persists a new Dispatch as queued', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      expect(dispatch.chain).toBe('solana');
      expect(dispatch.idempotencyKey).toBe('key-1');
      expect(dispatch.items).toEqual([solanaItem]);
      expect(dispatch.status).toBe('queued');
      expect(dispatch.id).toBeTruthy();
    });

    it('is idempotent: resubmitting the same key returns the original Dispatch (ADR-0021)', async () => {
      const first = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      const second = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [],
        retryPolicy: false,
      });

      expect(second).toEqual(first);
    });

    it('creates a distinct Dispatch for a distinct key', async () => {
      const first = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const second = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-2',
        items: [solanaItem],
        retryPolicy: false,
      });

      expect(second.id).not.toBe(first.id);
    });
  });

  describe('getDispatch', () => {
    it('returns null for an unknown id', async () => {
      expect(await store.getDispatch('missing')).toBeNull();
    });

    it('returns a previously created Dispatch', async () => {
      const created = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      expect(await store.getDispatch(created.id)).toEqual(created);
    });
  });

  describe('claimQueued', () => {
    it('claims queued Dispatches and moves them to broadcasting', async () => {
      const created = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      const claimed = await store.claimQueued(10);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(created.id);
      expect(claimed[0]?.status).toBe('broadcasting');
      expect((await store.getDispatch(created.id))?.status).toBe('broadcasting');
    });

    it('never claims the same Dispatch twice', async () => {
      await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [],
        retryPolicy: false,
      });

      const first = await store.claimQueued(10);
      const second = await store.claimQueued(10);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('respects the limit', async () => {
      await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [],
        retryPolicy: false,
      });
      await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-2',
        items: [],
        retryPolicy: false,
      });

      const claimed = await store.claimQueued(1);

      expect(claimed).toHaveLength(1);
    });
  });

  describe('transaction lifecycle', () => {
    it('creates a Transaction as PENDING', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      expect(transaction.status).toBe('PENDING');
      expect(transaction.hash).toBe('sig-1');
    });

    it('marks a Transaction confirmed', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      await store.markConfirmed(transaction.id);

      const confirmed = store.getTransaction(transaction.id);
      expect(confirmed?.status).toBe('CONFIRMED');
      expect(confirmed?.confirmedAt).toBeInstanceOf(Date);
    });

    it('reopens a CONFIRMED Transaction back to PENDING, clearing confirmedAt (base-chain-handler issue 07)', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });
      await store.markConfirmed(transaction.id);

      await store.reopenTransaction(transaction.id);

      const reopened = store.getTransaction(transaction.id);
      expect(reopened?.status).toBe('PENDING');
      expect(reopened?.confirmedAt).toBeNull();
    });

    it('marks a Transaction failed with a structured error', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      await store.markFailed(transaction.id, {
        code: 'CHAIN_REJECTED',
        message: 'simulation failed',
      });

      expect(store.getTransaction(transaction.id)?.status).toBe('FAILED');
      expect(store.getTransaction(transaction.id)?.error).toEqual({
        code: 'CHAIN_REJECTED',
        message: 'simulation failed',
      });
    });

    it('marks a Transaction abandoned', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      await store.markAbandoned(transaction.id);

      const abandoned = store.getTransaction(transaction.id);
      expect(abandoned?.status).toBe('ABANDONED');
      expect(abandoned?.abandonedAt).toBeInstanceOf(Date);
    });

    it('records a re-broadcast without changing status', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      await store.recordBroadcast(transaction.id, 'sig-1');

      expect(store.getTransaction(transaction.id)?.status).toBe('PENDING');
      expect(store.getAttempts(transaction.id)).toHaveLength(1);
    });

    it('rejects a re-broadcast whose hash differs from the Transaction it was signed as', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });
      const transaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      await expect(store.recordBroadcast(transaction.id, 'sig-different')).rejects.toThrow();
    });

    it('records a Call that failed before ever reaching a broadcast', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      const transaction = await store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        error: { code: 'INVALID_RECIPIENT', message: 'malformed recipient' },
      });

      expect(transaction.status).toBe('FAILED');
      expect(transaction.hash).toBeNull();
      expect(transaction.signedBytes).toBeNull();
      expect(transaction.error).toEqual({
        code: 'INVALID_RECIPIENT',
        message: 'malformed recipient',
      });
    });
  });

  describe('listTransactions', () => {
    it('returns a Dispatch’s Transactions ordered by callIndex', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });
      const second = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'solana',
        signedBytes: 'c2lnbmVkMg==',
        hash: 'sig-2',
      });
      const first = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVkMQ==',
        hash: 'sig-1',
      });

      const transactions = await store.listTransactions(dispatch.id);

      expect(transactions.map((t) => t.id)).toEqual([first.id, second.id]);
    });

    it('returns an empty list for a Dispatch with no Transactions yet', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: false,
      });

      expect(await store.listTransactions(dispatch.id)).toEqual([]);
    });
  });

  describe('listAbandonedTransactions', () => {
    it('returns only ABANDONED transactions whose abandonedAt is no earlier than notAbandonedBefore', async () => {
      let currentTime = new Date('2024-01-01T00:00:00.000Z');
      const clock = new InMemoryDispatchStore(() => currentTime);

      const dispatch = await clock.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem, solanaItem],
        retryPolicy: false,
      });
      const stillPending = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-pending',
      });
      const abandonedLongAgo = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-old',
      });
      await clock.markAbandoned(abandonedLongAgo.id);

      currentTime = new Date('2024-01-02T00:00:00.000Z'); // 24h later
      const abandonedRecently = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 2,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-recent',
      });
      await clock.markAbandoned(abandonedRecently.id);

      // A window that only includes the last 1 hour — excludes the one
      // abandoned 24h ago, excludes the still-PENDING one entirely (wrong
      // status), includes only the one abandoned 24h into the timeline.
      const notAbandonedBefore = new Date(currentTime.getTime() - 60 * 60 * 1000);
      const result = await clock.listAbandonedTransactions(10, notAbandonedBefore);

      expect(result.map((t) => t.id)).toEqual([abandonedRecently.id]);
      expect(result.map((t) => t.id)).not.toContain(stillPending.id);
      expect(result.map((t) => t.id)).not.toContain(abandonedLongAgo.id);
    });

    it('orders oldest-abandoned first and respects the limit', async () => {
      let currentTime = new Date('2024-01-01T00:00:00.000Z');
      const clock = new InMemoryDispatchStore(() => currentTime);
      const dispatch = await clock.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });

      const second = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-a',
      });
      currentTime = new Date('2024-01-01T01:00:00.000Z');
      await clock.markAbandoned(second.id);

      currentTime = new Date('2024-01-01T00:30:00.000Z'); // abandoned earlier than `second`, even though created after it
      const first = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-b',
      });
      await clock.markAbandoned(first.id);

      const all = await clock.listAbandonedTransactions(10, new Date(0));
      expect(all.map((t) => t.id)).toEqual([first.id, second.id]);

      const limited = await clock.listAbandonedTransactions(1, new Date(0));
      expect(limited.map((t) => t.id)).toEqual([first.id]);
    });
  });

  describe('fee-bump bookkeeping (#9)', () => {
    async function createOriginal() {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem],
        retryPolicy: true,
      });
      return store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'b3JpZ2luYWw=',
        hash: 'sig-original',
      });
    }

    it('creates a replacement for the same Call and marks the predecessor REPLACED', async () => {
      const original = await createOriginal();

      const replacement = await store.createReplacementTransaction(original.id, {
        signedBytes: 'YnVtcGVk',
        hash: 'sig-bumped',
      });

      expect(replacement).toMatchObject({
        dispatchId: original.dispatchId,
        callIndex: 0,
        chain: 'solana',
        status: 'PENDING',
        hash: 'sig-bumped',
        replacesTransactionId: original.id,
        feeBumpAttempts: 1,
      });
      expect(replacement.lastBroadcastAt).not.toBeNull();
      const all = await store.listTransactions(original.dispatchId);
      expect(all.find((t) => t.id === original.id)?.status).toBe('REPLACED');
    });

    it('lists every Transaction sharing a hash', async () => {
      const original = await createOriginal();
      const byHash = await store.listTransactionsByHash('sig-original');
      expect(byHash.map((t) => t.id)).toEqual([original.id]);
    });

    it('records fee-bump attempts and drops a version', async () => {
      const original = await createOriginal();
      await store.setFeeBumpAttempts(original.id, 3);
      await store.markDropped(original.id);

      const [row] = await store.listTransactionsByHash('sig-original');
      expect(row?.feeBumpAttempts).toBe(3);
      expect(row?.status).toBe('DROPPED');
    });

    it('stamps lastBroadcastAt on first broadcast and again on a rebroadcast Attempt', async () => {
      const original = await createOriginal();
      expect(original.lastBroadcastAt).not.toBeNull();
      await store.recordBroadcast(original.id, 'sig-original');
      const [row] = await store.listTransactionsByHash('sig-original');
      expect(row!.lastBroadcastAt!.getTime()).toBeGreaterThanOrEqual(
        original.lastBroadcastAt!.getTime(),
      );
    });
  });

  describe('bulkCall (#11)', () => {
    it("round-trips a Dispatch's bulkCall and each item's fundedBy", async () => {
      const created = await store.createDispatch({
        chain: 'base',
        idempotencyKey: 'key-bulk',
        items: [
          { call: { to: '0xabc', data: '0x', value: '1' }, payment: null },
          {
            call: { to: '0xtoken', data: '0xa9059cbb', value: '0' },
            payment: null,
            fundedBy: '0xaggregator',
          },
        ],
        retryPolicy: false,
        bulkCall: { aggregator: '0xaggregator', maxBatchSize: 2 },
      });

      const read = await store.getDispatch(created.id);

      expect(read?.bulkCall).toEqual({ aggregator: '0xaggregator', maxBatchSize: 2 });
      expect(read?.items.map((i) => i.fundedBy ?? null)).toEqual([null, '0xaggregator']);
    });

    it('defaults bulkCall to null', async () => {
      const created = await store.createDispatch({
        chain: 'base',
        idempotencyKey: 'key-bulk' + '-plain',
        items: [{ call: { to: '0xabc', data: '0x', value: '1' }, payment: null }],
        retryPolicy: false,
      });
      expect((await store.getDispatch(created.id))?.bulkCall).toBeNull();
    });
  });

  describe('listPendingTransactions', () => {
    it('rotates through every pending row, so long-pending rows never starve newer ones (#21)', async () => {
      let currentTime = new Date('2024-01-01T00:00:00.000Z');
      const clock = new InMemoryDispatchStore(() => currentTime);
      const dispatch = await clock.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem, solanaItem],
        retryPolicy: false,
      });
      const ids: string[] = [];
      for (const callIndex of [0, 1, 2]) {
        currentTime = new Date(currentTime.getTime() + 1_000);
        const transaction = await clock.createTransaction({
          dispatchId: dispatch.id,
          callIndex,
          chain: 'solana',
          signedBytes: 'c2lnbmVk',
          hash: `sig-${callIndex}`,
        });
        ids.push(transaction.id);
      }

      currentTime = new Date(currentTime.getTime() + 1_000);
      const firstTick = await clock.listPendingTransactions(2);
      currentTime = new Date(currentTime.getTime() + 1_000);
      const secondTick = await clock.listPendingTransactions(2);

      expect(firstTick.map((t) => t.id)).toEqual([ids[0], ids[1]]);
      expect(secondTick.map((t) => t.id)[0]).toBe(ids[2]);
    });
  });

  describe('listRecentlyConfirmedTransactions (base-chain-handler issue 07)', () => {
    it('returns only CONFIRMED transactions whose confirmedAt is no earlier than notConfirmedBefore', async () => {
      let currentTime = new Date('2024-01-01T00:00:00.000Z');
      const clock = new InMemoryDispatchStore(() => currentTime);

      const dispatch = await clock.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem, solanaItem],
        retryPolicy: false,
      });
      const stillPending = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-pending',
      });
      const confirmedLongAgo = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-old',
      });
      await clock.markConfirmed(confirmedLongAgo.id);

      currentTime = new Date('2024-01-02T00:00:00.000Z'); // 24h later
      const confirmedRecently = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 2,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-recent',
      });
      await clock.markConfirmed(confirmedRecently.id);

      const notConfirmedBefore = new Date(currentTime.getTime() - 60 * 60 * 1000);
      const result = await clock.listRecentlyConfirmedTransactions(
        'solana',
        10,
        notConfirmedBefore,
      );

      expect(result.map((t) => t.id)).toEqual([confirmedRecently.id]);
      expect(result.map((t) => t.id)).not.toContain(stillPending.id);
      expect(result.map((t) => t.id)).not.toContain(confirmedLongAgo.id);
    });

    it('orders oldest-confirmed first and respects the limit', async () => {
      let currentTime = new Date('2024-01-01T00:00:00.000Z');
      const clock = new InMemoryDispatchStore(() => currentTime);
      const dispatch = await clock.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });

      const second = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-a',
      });
      currentTime = new Date('2024-01-01T01:00:00.000Z');
      await clock.markConfirmed(second.id);

      currentTime = new Date('2024-01-01T00:30:00.000Z'); // confirmed earlier than `second`, even though created after it
      const first = await clock.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-b',
      });
      await clock.markConfirmed(first.id);

      const all = await clock.listRecentlyConfirmedTransactions('solana', 10, new Date(0));
      expect(all.map((t) => t.id)).toEqual([first.id, second.id]);

      const limited = await clock.listRecentlyConfirmedTransactions('solana', 1, new Date(0));
      expect(limited.map((t) => t.id)).toEqual([first.id]);
    });

    it("returns only the requested chain's rows, so another chain's volume can't use up the limit", async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });
      const solanaTransaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-solana',
      });
      await store.markConfirmed(solanaTransaction.id);
      const baseTransaction = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'base',
        signedBytes: 'c2lnbmVk',
        hash: '0xbase',
      });
      await store.markConfirmed(baseTransaction.id);

      const result = await store.listRecentlyConfirmedTransactions('base', 1, new Date(0));

      expect(result.map((t) => t.id)).toEqual([baseTransaction.id]);
    });
  });

  describe('createRelayDispatch', () => {
    it('persists a new RelayDispatch as queued, with no transactionId yet', async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });

      expect(relayDispatch.chain).toBe('solana');
      expect(relayDispatch.idempotencyKey).toBe('relay-key-1');
      expect(relayDispatch.signedTransaction).toBe('c2lnbmVk');
      expect(relayDispatch.status).toBe('queued');
      expect(relayDispatch.transactionId).toBeNull();
      expect(relayDispatch.id).toBeTruthy();
    });

    it('is idempotent: resubmitting the same key returns the original RelayDispatch (ADR-0021)', async () => {
      const first = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });

      const second = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'a-different-signed-transaction',
      });

      expect(second).toEqual(first);
    });

    it('creates a distinct RelayDispatch for a distinct key', async () => {
      const first = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });
      const second = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-2',
        signedTransaction: 'c2lnbmVk',
      });

      expect(second.id).not.toBe(first.id);
    });
  });

  describe('getRelayDispatch', () => {
    it('returns null for an unknown id', async () => {
      expect(await store.getRelayDispatch('missing')).toBeNull();
    });

    it('returns a previously created RelayDispatch', async () => {
      const created = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });

      expect(await store.getRelayDispatch(created.id)).toEqual(created);
    });
  });

  describe('claimQueuedRelayDispatches', () => {
    it('claims queued RelayDispatches and moves them to broadcasting', async () => {
      const created = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });

      const claimed = await store.claimQueuedRelayDispatches(10);

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(created.id);
      expect(claimed[0]?.status).toBe('broadcasting');
      expect((await store.getRelayDispatch(created.id))?.status).toBe('broadcasting');
    });

    it('never claims the same RelayDispatch twice', async () => {
      await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });

      const first = await store.claimQueuedRelayDispatches(10);
      const second = await store.claimQueuedRelayDispatches(10);

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('respects the limit', async () => {
      await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });
      await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-2',
        signedTransaction: 'c2lnbmVk',
      });

      const claimed = await store.claimQueuedRelayDispatches(1);

      expect(claimed).toHaveLength(1);
    });
  });

  describe('setRelayDispatchTransaction', () => {
    it('records which Transaction a RelayDispatch broadcast to', async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'solana',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'c2lnbmVk',
      });
      const transaction = await store.createTransaction({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: 'solana',
        signedBytes: 'c2lnbmVk',
        hash: 'sig-1',
      });

      await store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);

      expect((await store.getRelayDispatch(relayDispatch.id))?.transactionId).toBe(transaction.id);
    });

    it('rejects setting a transactionId on an unknown RelayDispatch', async () => {
      await expect(
        store.setRelayDispatchTransaction('missing', 'some-transaction-id'),
      ).rejects.toThrow();
    });
  });
});
