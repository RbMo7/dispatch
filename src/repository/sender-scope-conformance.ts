import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import type { SenderAddress, SenderRef } from '../domain/sender.js';
import type { DispatchStore } from './dispatch-store.js';

const PAYOUTS: SenderRef = { chain: 'solana', address: 'payouts' as SenderAddress };
const TREASURY: SenderRef = { chain: 'solana', address: 'treasury' as SenderAddress };
const BASE: SenderRef = { chain: 'base', address: '0xpayouts' as SenderAddress };

const solanaItem = (amount: string): DispatchItem<'solana'> => ({
  call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' },
  payment: { recipient: 'r', asset: 'USDC', amount },
});
const baseItem: DispatchItem<'base'> = {
  call: { to: '0xabc', data: '0x', value: '0' },
  payment: null,
};

let counter = 0;

function seed(store: DispatchStore, sender: SenderRef | null, amount = '10') {
  const idempotencyKey = `sender-scope-${counter++}-${Math.random()}`;
  const senderAddress = sender?.address ?? null;
  return sender?.chain === 'base'
    ? store.createDispatch({
        chain: 'base',
        idempotencyKey,
        items: [baseItem],
        retryPolicy: false,
        senderAddress,
      })
    : store.createDispatch({
        chain: 'solana',
        idempotencyKey,
        items: [solanaItem(amount)],
        retryPolicy: false,
        senderAddress,
      });
}

/**
 * ADR-0060: the work queues a Sender reads return only that Sender's rows,
 * and a row stored with no Sender belongs to nobody until its chain's default
 * takes it. Run against both the fake and the real store so they can't drift.
 */
export function runSenderScopeConformanceSuite(makeStore: () => DispatchStore): void {
  describe('sender scope (ADR-0060)', () => {
    it('keeps the Sender a Dispatch was created with, and none when it named none', async () => {
      const store = makeStore();
      const named = await seed(store, PAYOUTS);
      const unnamed = await seed(store, null);
      expect((await store.getDispatch(named.id))?.senderAddress).toBe(PAYOUTS.address);
      expect((await store.getDispatch(unnamed.id))?.senderAddress).toBeNull();
    });

    it("claims only one Sender's queued Dispatches, oldest first", async () => {
      const store = makeStore();
      const first = await seed(store, PAYOUTS);
      const other = await seed(store, TREASURY);
      const unassigned = await seed(store, null);
      const elsewhere = await seed(store, BASE);
      const second = await seed(store, PAYOUTS);

      const claimed = await store.claimQueuedFor(PAYOUTS, 1);
      expect(claimed.map((d) => d.id)).toEqual([first.id]);
      expect(claimed[0]?.status).toBe('broadcasting');
      expect((await store.claimQueuedFor(PAYOUTS, 10)).map((d) => d.id)).toEqual([second.id]);
      expect(await store.claimQueuedFor(PAYOUTS, 10)).toEqual([]);
      for (const untouched of [other, unassigned, elsewhere]) {
        expect((await store.getDispatch(untouched.id))?.status).toBe('queued');
      }
    });

    it("gives a chain's Dispatches stored with no Sender to one Sender, whatever their status, once", async () => {
      const store = makeStore();
      const inFlight = await seed(store, null);
      await store.claimQueued(['solana'], 10);
      const queued = await seed(store, null);
      const named = await seed(store, TREASURY);
      const elsewhere = await store.createDispatch({
        chain: 'base',
        idempotencyKey: `sender-scope-base-${Math.random()}`,
        items: [baseItem],
        retryPolicy: false,
      });

      expect(await store.assignUnassignedDispatches(PAYOUTS)).toBe(2);
      expect(await store.assignUnassignedDispatches(PAYOUTS)).toBe(0);

      expect(await store.getDispatch(inFlight.id)).toMatchObject({
        status: 'broadcasting',
        senderAddress: PAYOUTS.address,
      });
      expect(await store.getDispatch(queued.id)).toMatchObject({
        status: 'queued',
        senderAddress: PAYOUTS.address,
      });
      expect((await store.getDispatch(named.id))?.senderAddress).toBe(TREASURY.address);
      expect((await store.getDispatch(elsewhere.id))?.senderAddress).toBeNull();
    });

    it("lists one Sender's UNPROPOSED Calls and what they commit, never another's", async () => {
      const store = makeStore();
      const mine = await seed(store, PAYOUTS, '10');
      const theirs = await seed(store, TREASURY, '25');
      await store.claimQueued(['solana'], 10);
      await store.noteUnproposed([
        { dispatchId: mine.id, callIndex: 0, chain: 'solana' },
        { dispatchId: theirs.id, callIndex: 0, chain: 'solana' },
      ]);

      const listed = await store.listUnproposed('solana', 10, PAYOUTS.address);
      expect(listed.map((t) => t.dispatchId)).toEqual([mine.id]);
      expect(await store.listUnproposed('solana', 10)).toHaveLength(2);

      const since = new Date(0);
      expect(await store.listCommitted('solana', 'sender', since, PAYOUTS.address)).toEqual([
        { asset: 'USDC', amount: '10' },
      ]);
      expect(await store.listCommitted('solana', 'sender', since, TREASURY.address)).toEqual([
        { asset: 'USDC', amount: '25' },
      ]);
      expect(await store.listCommitted('solana', 'sender', since)).toEqual([
        { asset: 'USDC', amount: '35' },
      ]);
    });

    it("counts only a Sender's own Proposals as committed", async () => {
      const store = makeStore();
      const mine = await seed(store, PAYOUTS, '10');
      const theirs = await seed(store, TREASURY, '25');
      await store.claimQueued(['solana'], 10);
      const calls = await store.noteUnproposed([
        { dispatchId: mine.id, callIndex: 0, chain: 'solana' },
        { dispatchId: theirs.id, callIndex: 0, chain: 'solana' },
      ]);
      for (const [index, sender] of [PAYOUTS, TREASURY].entries()) {
        const call = calls[index];
        if (!call) throw new Error('no call');
        const n = counter++;
        await store.createProposal({
          dispatchId: call.dispatchId,
          chain: 'solana',
          senderAddress: sender.address,
          chainRef: {
            kind: 'squads',
            multisig: sender.address,
            proposal: `p-${n}`,
            transactionIndex: n,
          },
          payload: 'payload',
          proposalRef: `sender-scope-${n}-${Math.random()}`,
          sequence: n,
          threshold: 2,
          deadlineAt: new Date(Date.now() + 3_600_000),
          executeAfter: null,
          proposeSignedBytes: 'signed',
          proposeHash: `hash-${n}`,
          expected: { recipients: 1, totals: [] },
          committed: { sender: [], proposer: [{ asset: 'SOL', amount: String(index + 1) }] },
          transactionIds: [call.id],
        });
      }

      const since = new Date(0);
      expect(await store.listCommitted('solana', 'proposer', since, PAYOUTS.address)).toEqual([
        { asset: 'SOL', amount: '1' },
      ]);
      expect(await store.listCommitted('solana', 'proposer', since, TREASURY.address)).toEqual([
        { asset: 'SOL', amount: '2' },
      ]);
    });
  });
}
