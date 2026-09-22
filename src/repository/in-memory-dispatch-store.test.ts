import { beforeEach, describe, expect, it } from 'vitest';

import type { SolanaCall } from '../domain/call.js';
import { InMemoryDispatchStore } from './in-memory-dispatch-store.js';

const solanaCall: SolanaCall = { programId: 'prog', accounts: [], data: 'ZGF0YQ==' };

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
        items: [solanaCall],
        retryPolicy: false,
      });

      expect(dispatch.chain).toBe('solana');
      expect(dispatch.idempotencyKey).toBe('key-1');
      expect(dispatch.items).toEqual([solanaCall]);
      expect(dispatch.status).toBe('queued');
      expect(dispatch.id).toBeTruthy();
    });

    it('is idempotent: resubmitting the same key returns the original Dispatch (ADR-0021)', async () => {
      const first = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaCall],
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
        items: [solanaCall],
        retryPolicy: false,
      });
      const second = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-2',
        items: [solanaCall],
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
        items: [solanaCall],
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
        items: [solanaCall],
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
        items: [solanaCall],
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
        items: [solanaCall],
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

      expect(store.getTransaction(transaction.id)?.status).toBe('CONFIRMED');
    });

    it('marks a Transaction failed with a structured error', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaCall],
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
        items: [solanaCall],
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

      expect(store.getTransaction(transaction.id)?.status).toBe('ABANDONED');
    });

    it('records a re-broadcast without changing status', async () => {
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: 'key-1',
        items: [solanaCall],
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
        items: [solanaCall],
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
        items: [solanaCall],
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
        items: [solanaCall, solanaCall],
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
        items: [solanaCall],
        retryPolicy: false,
      });

      expect(await store.listTransactions(dispatch.id)).toEqual([]);
    });
  });
});
