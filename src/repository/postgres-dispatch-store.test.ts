import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../db/client.js';
import {
  attempts,
  dispatches,
  dispatchHolds,
  flagRules,
  flagRuleVersions,
  operatorActions,
  proposals,
  relayDispatches,
  setupChecks,
  signerKeys,
  transactions,
} from '../db/schema.js';
import type { DispatchItem, SolanaCall } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import { runCancelConformanceSuite } from './cancel-conformance.js';
import { runChainScopeConformanceSuite } from './chain-scope-conformance.js';
import { PostgresDispatchStore } from './postgres-dispatch-store.js';
import { runProposalStoreConformanceSuite } from './proposal-store-conformance.js';
import { runListConformanceSuite } from './list-conformance.js';
import { runSetupCheckConformanceSuite } from './setup-check-conformance.js';
import { runSenderScopeConformanceSuite } from './sender-scope-conformance.js';
import { runSignerKeyConformanceSuite } from './signer-key-conformance.js';
import { runTimelineConformanceSuite } from './timeline-conformance.js';
import { runFlagRuleConformanceSuite } from './flag-rule-conformance.js';

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
    sql`TRUNCATE TABLE ${attempts}, ${transactions}, ${proposals}, ${relayDispatches}, ${dispatches}, ${operatorActions}, ${dispatchHolds}, ${flagRuleVersions}, ${flagRules}, ${signerKeys}, ${setupChecks} RESTART IDENTITY CASCADE`,
  );
}

describe('PostgresDispatchStore (real Postgres)', () => {
  let store: PostgresDispatchStore;

  beforeEach(async () => {
    store = new PostgresDispatchStore(db);
    await truncateAll();
  });

  runChainScopeConformanceSuite(() => new PostgresDispatchStore(db));
  runSenderScopeConformanceSuite(() => new PostgresDispatchStore(db));
  runCancelConformanceSuite(() => new PostgresDispatchStore(db));
  runProposalStoreConformanceSuite(() => new PostgresDispatchStore(db));
  runListConformanceSuite(() => new PostgresDispatchStore(db));
  runTimelineConformanceSuite(() => new PostgresDispatchStore(db));
  runFlagRuleConformanceSuite(() => new PostgresDispatchStore(db));
  runSignerKeyConformanceSuite(() => new PostgresDispatchStore(db));
  runSetupCheckConformanceSuite(() => new PostgresDispatchStore(db));

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

  describe('cancelDispatch racing claimQueued (ADR-0056)', () => {
    it('lets exactly one of a concurrent cancel and claim win, and stores the winner', async () => {
      for (let round = 0; round < 5; round++) {
        await truncateAll();
        const created = await Promise.all(
          Array.from({ length: 20 }, () =>
            store.createDispatch({
              chain: 'solana',
              idempotencyKey: randomUUID(),
              items: [solanaItem],
              retryPolicy: false,
            }),
          ),
        );

        const [claimed, ...outcomes] = await Promise.all([
          store.claimQueued(CHAINS, 100),
          ...created.map((d) => store.cancelDispatch(d.id, { tokenKind: 'auth', reason: null })),
        ]);

        const claimedIds = new Set(claimed.map((d) => d.id));
        for (const [i, dispatch] of created.entries()) {
          const cancelled = outcomes[i] === 'cancelled';
          expect(cancelled).toBe(!claimedIds.has(dispatch.id));
          expect(outcomes[i]).toBe(cancelled ? 'cancelled' : 'already_claimed');
          expect((await store.getDispatch(dispatch.id))?.status).toBe(
            cancelled ? 'cancelled' : 'broadcasting',
          );
        }
      }
    });
  });

  describe('a held Dispatch (ADR-0058)', () => {
    it('is never claimed by a claim loop running while Dispatches arrive', async () => {
      const rule = await store.createFlagRule(
        {
          name: 'Everything',
          chain: 'solana',
          senderAddress: null,
          enabled: true,
          definition: { kind: 'call_target_not_allowlisted', addresses: [] },
        },
        { tokenKind: 'operator', reason: null },
      );
      const claimed = new Set<string>();
      let arriving = true;
      const claimLoop = (async () => {
        while (arriving) {
          for (const d of await store.claimQueued(CHAINS, 5)) claimed.add(d.id);
        }
        for (const d of await store.claimQueued(CHAINS, 100)) claimed.add(d.id);
      })();

      const created = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          store.createDispatch({
            chain: 'solana',
            idempotencyKey: randomUUID(),
            items: [solanaItem],
            retryPolicy: false,
            ...(i % 2 === 0 ? { hold: [{ rule: rule.current, items: [0] }] } : {}),
          }),
        ),
      );
      arriving = false;
      await claimLoop;

      const held = created.filter((d) => d.status === 'held').map((d) => d.id);
      const queued = created.filter((d) => d.status === 'queued').map((d) => d.id);
      expect(held).toHaveLength(20);
      expect([...claimed].sort()).toEqual([...queued].sort());
      for (const id of held) expect((await store.getDispatch(id))?.status).toBe('held');
    });

    const heldDispatches = async (count: number) => {
      const rule = await store.createFlagRule(
        {
          name: 'Everything',
          chain: 'solana',
          senderAddress: null,
          enabled: true,
          definition: { kind: 'call_target_not_allowlisted', addresses: [] },
        },
        { tokenKind: 'operator', reason: null },
      );
      return Promise.all(
        Array.from({ length: count }, () =>
          store.createDispatch({
            chain: 'solana',
            idempotencyKey: randomUUID(),
            items: [solanaItem],
            retryPolicy: false,
            hold: [{ rule: rule.current, items: [0] }],
          }),
        ),
      );
    };

    const actionsByTarget = async () => {
      const actions = await store.listOperatorActions({ after: null, limit: 1000 });
      const byTarget = new Map<string, string[]>();
      for (const { action } of [...actions].reverse()) {
        byTarget.set(action.targetId, [...(byTarget.get(action.targetId) ?? []), action.action]);
      }
      return byTarget;
    };

    it('lets exactly one of a concurrent release and cancel take it out of held', async () => {
      for (let round = 0; round < 5; round++) {
        await truncateAll();
        const held = await heldDispatches(20);

        const outcomes = await Promise.all(
          held.map((d) =>
            Promise.all([
              store.releaseDispatch(d.id, 'looked fine'),
              store.cancelDispatch(d.id, { tokenKind: 'auth', reason: null }),
            ]),
          ),
        );

        const actions = await actionsByTarget();
        for (const [i, dispatch] of held.entries()) {
          const [release, cancel] = outcomes[i] ?? [];
          const hold = await store.getHold(dispatch.id);
          // Both land only in order: the release first, then a cancel of the queued Dispatch (ADR-0056).
          expect(cancel).toBe('cancelled');
          expect((await store.getDispatch(dispatch.id))?.status).toBe('cancelled');
          if (release === 'released') {
            expect(hold?.release?.reason).toBe('looked fine');
            expect(actions.get(dispatch.id)).toEqual(['release', 'cancel']);
          } else {
            expect(release).toBe('not_held');
            expect(hold?.release).toBeNull();
            expect(actions.get(dispatch.id)).toEqual(['cancel']);
          }
        }
      }
    });

    it('lets exactly one of two concurrent releases win, and records one release', async () => {
      const held = await heldDispatches(20);

      const outcomes = await Promise.all(
        held.map((d) =>
          Promise.all([store.releaseDispatch(d.id, 'a'), store.releaseDispatch(d.id, 'b')]),
        ),
      );

      const actions = await actionsByTarget();
      for (const [i, dispatch] of held.entries()) {
        expect([...(outcomes[i] ?? [])].sort()).toEqual(['not_held', 'released']);
        expect(actions.get(dispatch.id)).toEqual(['release']);
        expect((await store.getDispatch(dispatch.id))?.status).toBe('queued');
      }
    });

    it('never lets a cancel land on a released Dispatch the worker already claimed', async () => {
      const held = await heldDispatches(20);

      const [, ...outcomes] = await Promise.all([
        (async () => {
          await Promise.all(held.map((d) => store.releaseDispatch(d.id, 'go')));
          return store.claimQueued(CHAINS, 100);
        })(),
        ...held.map((d) => store.cancelDispatch(d.id, { tokenKind: 'auth', reason: null })),
      ]);

      for (const [i, dispatch] of held.entries()) {
        const status = (await store.getDispatch(dispatch.id))?.status;
        expect(status).toBe(outcomes[i] === 'cancelled' ? 'cancelled' : 'broadcasting');
      }
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
