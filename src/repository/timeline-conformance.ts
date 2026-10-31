import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildTimeline, type TimelineEntry } from '../api/timeline.js';
import type { DispatchItem } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import type { DispatchStore } from './dispatch-store.js';

const baseItem: DispatchItem<'base'> = {
  call: { to: '0xabc', data: '0x', value: '0' },
  payment: { recipient: '0xabc', asset: 'USDC', amount: '10' },
};
const solanaItem: DispatchItem<'solana'> = {
  call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' },
  payment: { recipient: 'r', asset: 'USDC', amount: '10' },
};

/** Lets each step land on a later millisecond, so the order under test is the order of the steps. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function timelineOf(store: DispatchStore, id: string): Promise<TimelineEntry[]> {
  const dispatch = (await store.getDispatch(id)) ?? (await store.getRelayDispatch(id));
  if (!dispatch) throw new Error(`no Dispatch ${id}`);
  const transactions = await store.listTransactions(id);
  return buildTimeline({
    dispatch,
    transactions,
    attempts: await store.listAttempts(id),
    proposals: transactions.some((t) => t.proposalId !== null)
      ? await store.listProposalsForDispatch(id)
      : [],
  });
}

/** Drops `at` so the entries read as the story they tell, in order. */
function story(timeline: TimelineEntry[]) {
  for (let i = 1; i < timeline.length; i++) {
    const [prev, next] = [timeline[i - 1]?.at, timeline[i]?.at];
    if (prev && next) expect(next.getTime()).toBeGreaterThanOrEqual(prev.getTime());
  }
  return timeline.map(({ at: _at, ...rest }) => rest);
}

/**
 * #109: the timeline rebuilt from what each store keeps. Run against both the
 * fake and the real store, so the timestamps it relies on are written by both.
 */
export function runTimelineConformanceSuite(makeStore: () => DispatchStore): void {
  describe('timeline (#109)', () => {
    it('shows each version of a fee-bumped Base Call, its Attempts, and which version landed', async () => {
      const store = makeStore();
      const dispatch = await store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        items: [baseItem],
        retryPolicy: true,
      });
      await tick();
      await store.claimQueued(CHAINS, 10);
      await tick();
      const original = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: 'b1',
        hash: 'h1',
      });
      await tick();
      await store.recordSent(original.id, 'h1');
      await tick();
      await store.recordBroadcast(original.id, 'h1', {
        code: 'ALREADY_KNOWN',
        message: 'already known',
      });
      await tick();
      const bump = await store.createReplacementTransaction(original.id, {
        signedBytes: 'b2',
        hash: 'h2',
      });
      await tick();
      await store.recordSent(bump.id, 'h2');
      await tick();
      await store.markConfirmed(original.id);
      await store.markDropped(bump.id);

      expect(story(await timelineOf(store, dispatch.id))).toEqual([
        { kind: 'created' },
        { kind: 'claimed' },
        { kind: 'written', hash: 'h1', items: [0], replaces: null },
        {
          kind: 'attempt',
          hash: 'h1',
          items: [0],
          error: { code: 'ALREADY_KNOWN', message: 'already known' },
        },
        { kind: 'written', hash: 'h2', items: [0], replaces: 'h1' },
        { kind: 'replaced', hash: 'h1', items: [0], by: 'h2' },
        { kind: 'sent', hash: 'h2', items: [0] },
        { kind: 'confirmed', hash: 'h1', items: [0] },
        { kind: 'dropped', hash: 'h2', items: [0], by: null },
      ]);
    });

    it('shows the dropped version of a Solana Call resubmitted after expiry, then the resubmission', async () => {
      const store = makeStore();
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });
      await store.claimQueued(CHAINS, 10);
      await tick();
      const bundle = await store.createTransactions(
        [0, 1].map((callIndex) => ({
          dispatchId: dispatch.id,
          callIndex,
          chain: 'solana' as const,
          signedBytes: 's1',
          hash: 'sig1',
        })),
      );
      await tick();
      for (const row of bundle) await store.recordSent(row.id, 'sig1');
      await tick();
      const resubmitted = [];
      for (const row of bundle) {
        resubmitted.push(
          await store.createReplacementTransaction(row.id, { signedBytes: 's2', hash: 'sig2' }),
        );
        await store.markDropped(row.id);
      }
      await tick();
      for (const row of resubmitted) await store.recordSent(row.id, 'sig2');
      await tick();
      for (const row of resubmitted) await store.markConfirmed(row.id);

      const entries = story(await timelineOf(store, dispatch.id)).slice(2);
      expect(entries).toEqual([
        { kind: 'written', hash: 'sig1', items: [0, 1], replaces: null },
        { kind: 'sent', hash: 'sig1', items: [0, 1] },
        { kind: 'written', hash: 'sig2', items: [0, 1], replaces: 'sig1' },
        { kind: 'dropped', hash: 'sig1', items: [0, 1], by: 'sig2' },
        { kind: 'sent', hash: 'sig2', items: [0, 1] },
        { kind: 'confirmed', hash: 'sig2', items: [0, 1] },
      ]);
    });

    it("shows a Multisig Sender's Proposal created, approved, executed and resolved", async () => {
      const store = makeStore();
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem, solanaItem],
        retryPolicy: false,
      });
      await store.claimQueued(CHAINS, 10);
      const calls = await store.noteUnproposed(
        [0, 1].map((callIndex) => ({ dispatchId: dispatch.id, callIndex, chain: 'solana' })),
      );
      await tick();
      const chainRef = {
        kind: 'squads' as const,
        multisig: 'ms',
        proposal: `prop-${randomUUID()}`,
        transactionIndex: 1,
      };
      const proposal = await store.createProposal({
        dispatchId: dispatch.id,
        chain: 'solana',
        senderAddress: 'vault',
        chainRef,
        payload: 'payload',
        proposalRef: chainRef.proposal,
        sequence: null,
        threshold: 2,
        deadlineAt: new Date(Date.now() + 3_600_000),
        executeAfter: null,
        proposeSignedBytes: 'propose',
        proposeHash: 'propose-hash',
        expected: { recipients: 1, totals: [{ asset: 'USDC', amount: '20' }] },
        committed: { sender: [], proposer: [] },
        transactionIds: calls.map((c) => c.id),
      });
      await store.updateProposal(proposal.id, {
        phase: 'open',
        approvalState: 'approved',
        approvals: 2,
      });
      await tick();
      const executing = await store.markProposalExecuting(proposal.id, 'exec', 'exec-hash');
      await tick();
      for (const row of executing) await store.recordSent(row.id, 'exec-hash');
      await tick();
      await store.settleProposal(proposal.id, { status: 'CONFIRMED' });

      const entries = story(await timelineOf(store, dispatch.id)).slice(2);
      expect(entries).toEqual([
        { kind: 'proposal_created', proposalId: proposal.id, chainRef, items: [0, 1] },
        {
          kind: 'proposal_approval',
          proposalId: proposal.id,
          state: 'approved',
          approvals: 2,
          threshold: 2,
        },
        { kind: 'written', hash: 'exec-hash', items: [0, 1], replaces: null },
        { kind: 'sent', hash: 'exec-hash', items: [0, 1] },
        { kind: 'confirmed', hash: 'exec-hash', items: [0, 1] },
        { kind: 'proposal_resolved', proposalId: proposal.id, outcome: 'executed' },
      ]);
    });

    it('stamps every way a Call can fail, so each shows when it failed', async () => {
      const store = makeStore();
      const dispatch = await store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        items: [baseItem, baseItem],
        retryPolicy: false,
      });
      await store.claimQueued(CHAINS, 10);
      await tick();
      await store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'base',
        error: { code: 'INSUFFICIENT_FUNDS', message: 'short' },
      });
      await tick();
      const refused = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 1,
        chain: 'base',
        signedBytes: 'b',
        hash: 'h',
      });
      await tick();
      await store.markFailed(refused.id, { code: 'CHAIN_REJECTED', message: 'reverted' });

      const entries = story(await timelineOf(store, dispatch.id)).slice(2);
      expect(entries).toEqual([
        {
          kind: 'failed',
          hash: null,
          items: [0],
          error: { code: 'INSUFFICIENT_FUNDS', message: 'short' },
        },
        { kind: 'written', hash: 'h', items: [1], replaces: null },
        {
          kind: 'failed',
          hash: 'h',
          items: [1],
          error: { code: 'CHAIN_REJECTED', message: 'reverted' },
        },
      ]);
    });

    it('shows a rejected Proposal failing its Calls', async () => {
      const store = makeStore();
      const dispatch = await store.createDispatch({
        chain: 'solana',
        idempotencyKey: randomUUID(),
        items: [solanaItem],
        retryPolicy: false,
      });
      await store.claimQueued(CHAINS, 10);
      const calls = await store.noteUnproposed([
        { dispatchId: dispatch.id, callIndex: 0, chain: 'solana' },
      ]);
      const ref = `prop-${randomUUID()}`;
      const proposal = await store.createProposal({
        dispatchId: dispatch.id,
        chain: 'solana',
        senderAddress: 'vault',
        chainRef: { kind: 'squads', multisig: 'ms', proposal: ref, transactionIndex: 2 },
        payload: 'payload',
        proposalRef: ref,
        sequence: null,
        threshold: 2,
        deadlineAt: new Date(Date.now() + 3_600_000),
        executeAfter: null,
        proposeSignedBytes: 'propose',
        proposeHash: 'propose-hash',
        expected: { recipients: 1, totals: [] },
        committed: { sender: [], proposer: [] },
        transactionIds: calls.map((c) => c.id),
      });
      await tick();
      const rejected = { code: 'APPROVAL_REJECTED' as const, message: 'rejected' };
      await store.settleProposal(proposal.id, { status: 'FAILED', error: rejected });

      const kinds = story(await timelineOf(store, dispatch.id)).map((e) => e.kind);
      expect(kinds.slice(2)).toEqual([
        'proposal_created',
        'proposal_approval',
        'failed',
        'proposal_resolved',
      ]);
      const resolved = (await timelineOf(store, dispatch.id)).find(
        (e) => e.kind === 'proposal_resolved',
      );
      expect(resolved).toMatchObject({ outcome: 'rejected' });
    });

    it('gives a Relay Dispatch the same shape for its one Transaction', async () => {
      const store = makeStore();
      const relay = await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        signedTransaction: 'signed',
      });
      await tick();
      await store.claimQueuedRelayDispatches(CHAINS, 10);
      await tick();
      const transaction = await store.createTransaction({
        dispatchId: relay.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: 'signed',
        hash: 'relay-hash',
      });
      await tick();
      await store.recordSent(transaction.id, 'relay-hash');
      await tick();
      await store.markConfirmed(transaction.id);

      expect(story(await timelineOf(store, relay.id))).toEqual([
        { kind: 'created' },
        { kind: 'claimed' },
        { kind: 'written', hash: 'relay-hash', items: [0], replaces: null },
        { kind: 'sent', hash: 'relay-hash', items: [0] },
        { kind: 'confirmed', hash: 'relay-hash', items: [0] },
      ]);
    });

    it('shows when a Dispatch was cancelled', async () => {
      const store = makeStore();
      const dispatch = await store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        items: [baseItem],
        retryPolicy: false,
      });
      await tick();
      await store.cancelDispatch(dispatch.id);

      expect(story(await timelineOf(store, dispatch.id))).toEqual([
        { kind: 'created' },
        { kind: 'cancelled' },
      ]);
    });
  });
}
