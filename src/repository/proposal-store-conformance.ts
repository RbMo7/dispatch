import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { ChainProposalRef, CommittedAmounts, ExpectedTotals } from '../domain/proposal.js';
import type { Transaction } from '../domain/transaction.js';
import type { DispatchStore, NewProposalInput } from './dispatch-store.js';

const PAST = new Date(0);

const solanaItem = (amount: string): DispatchItem<'solana'> => ({
  call: { programId: 'prog', accounts: [], data: 'ZGF0YQ==' },
  payment: { recipient: 'r', asset: 'USDC', amount },
});

const baseItem = (amount: string): DispatchItem<'base'> => ({
  call: { to: '0xabc', data: '0x', value: '0' },
  payment: { recipient: '0xabc', asset: 'USDC', amount },
});

const squadsRef = (n: number): ChainProposalRef => ({
  kind: 'squads',
  multisig: 'ms',
  proposal: `prop-${n}`,
  transactionIndex: n,
});

const expected: ExpectedTotals = { recipients: 2, totals: [{ asset: 'USDC', amount: '30' }] };
const committed: CommittedAmounts = {
  sender: [{ asset: 'USDC', amount: '30' }],
  proposer: [{ asset: 'SOL', amount: '5' }],
};

let counter = 0;

/** A Dispatch of `n` items whose Calls are all written down `UNPROPOSED`. */
async function seedUnproposed(store: DispatchStore, chain: Chain, n = 2) {
  const amounts = Array.from({ length: n }, (_, i) => String((i + 1) * 10));
  const dispatch =
    chain === 'solana'
      ? await store.createDispatch({
          chain,
          idempotencyKey: `k-${counter++}-${Math.random()}`,
          items: amounts.map(solanaItem),
          retryPolicy: false,
        })
      : await store.createDispatch({
          chain,
          idempotencyKey: `k-${counter++}-${Math.random()}`,
          items: amounts.map(baseItem),
          retryPolicy: false,
        });
  await store.claimQueued([chain], 100);
  const calls = await store.noteUnproposed(
    amounts.map((_, callIndex) => ({ dispatchId: dispatch.id, callIndex, chain })),
  );
  return { dispatch, calls };
}

function proposalInput(
  dispatchId: string,
  calls: Transaction[],
  overrides: Partial<NewProposalInput> = {},
): NewProposalInput {
  const n = counter++;
  return {
    dispatchId,
    chain: 'solana',
    senderAddress: 'vault',
    chainRef: squadsRef(n),
    payload: 'payload',
    proposalRef: `prop-${n}`,
    sequence: n,
    threshold: 2,
    deadlineAt: new Date(Date.now() + 72 * 3_600_000),
    executeAfter: null,
    proposeSignedBytes: 'signed-propose',
    proposeHash: 'propose-hash',
    expected,
    committed,
    transactionIds: calls.map((c) => c.id),
    ...overrides,
  };
}

/**
 * ADR-0054: the multisig approval half of DispatchStore (proposals, the two
 * additive Transaction statuses, and the atomic writes around them). Run
 * against both the fake and the real store so they can't drift apart.
 */
export function runProposalStoreConformanceSuite(makeStore: () => DispatchStore): void {
  describe('multisig approval (ADR-0054)', () => {
    describe('noteUnproposed / listUnproposed', () => {
      it('writes each Call down UNPROPOSED, with no hash, and is idempotent per Call', async () => {
        const store = makeStore();
        const { dispatch, calls } = await seedUnproposed(store, 'solana');

        expect(calls).toHaveLength(2);
        for (const call of calls) {
          expect(call).toMatchObject({
            status: 'UNPROPOSED',
            hash: null,
            signedBytes: null,
            error: null,
            proposalId: null,
            proposalPosition: null,
          });
        }

        const again = await store.noteUnproposed([
          { dispatchId: dispatch.id, callIndex: 0, chain: 'solana' },
        ]);
        expect(again.map((c) => c.id)).toEqual([calls[0]?.id]);
        expect(await store.listTransactions(dispatch.id)).toHaveLength(2);
      });

      it('lists one chain, first Dispatch first and by callIndex, up to the limit', async () => {
        const store = makeStore();
        const first = await seedUnproposed(store, 'solana', 2);
        const second = await seedUnproposed(store, 'solana', 2);
        await seedUnproposed(store, 'base', 1);

        const all = await store.listUnproposed('solana', 100);
        expect(all.map((c) => [c.dispatchId, c.callIndex])).toEqual([
          [first.dispatch.id, 0],
          [first.dispatch.id, 1],
          [second.dispatch.id, 0],
          [second.dispatch.id, 1],
        ]);
        expect(await store.listUnproposed('solana', 3)).toHaveLength(3);
        expect(await store.listUnproposed('base', 100)).toHaveLength(1);
      });

      it('keeps a Dispatch with every Call written down out of reclaimStaleDispatches', async () => {
        const store = makeStore();
        await seedUnproposed(store, 'solana', 2);
        const later = new Date(Date.now() + 60_000);
        expect(await store.reclaimStaleDispatches(['solana'], later, 100)).toEqual([]);
      });
    });

    describe('createProposal', () => {
      it('atomically writes a noted Proposal and moves its Calls to AWAITING_APPROVAL, in position order', async () => {
        const store = makeStore();
        const { dispatch, calls } = await seedUnproposed(store, 'solana');
        const [a, b] = calls as [Transaction, Transaction];

        // Position follows the order of transactionIds, not of callIndex.
        const proposal = await store.createProposal(
          proposalInput(dispatch.id, [b, a], { sequence: 7 }),
        );

        expect(proposal).toMatchObject({
          dispatchId: dispatch.id,
          chain: 'solana',
          phase: 'noted',
          approvalState: 'awaiting',
          approvals: 0,
          threshold: 2,
          sequence: 7,
          timedOutAt: null,
          resolvedAt: null,
          checkFailures: 0,
          proposeSignedBytes: 'signed-propose',
          proposeHash: 'propose-hash',
          expected,
          committed,
        });
        expect(await store.getProposal(proposal.id)).toEqual(proposal);

        const stored = await store.listProposalCalls(proposal.id);
        expect(
          stored.map((c) => [c.id, c.status, c.proposalId, c.proposalPosition, c.hash]),
        ).toEqual([
          [b.id, 'AWAITING_APPROVAL', proposal.id, 0, null],
          [a.id, 'AWAITING_APPROVAL', proposal.id, 1, null],
        ]);
        expect(await store.listUnproposed('solana', 100)).toEqual([]);
      });

      it('changes nothing when a Call is not UNPROPOSED', async () => {
        const store = makeStore();
        const { dispatch, calls } = await seedUnproposed(store, 'solana');
        const [a, b] = calls as [Transaction, Transaction];
        await store.createProposal(proposalInput(dispatch.id, [a]));

        // `a` is already in a Proposal, `b` is still free.
        await expect(store.createProposal(proposalInput(dispatch.id, [b, a]))).rejects.toThrow();
        expect((await store.listUnproposed('solana', 100)).map((c) => c.id)).toEqual([b.id]);
      });

      it('never mixes Dispatches (ADR-0054), and changes nothing when asked to', async () => {
        const store = makeStore();
        const one = await seedUnproposed(store, 'solana', 1);
        const two = await seedUnproposed(store, 'solana', 1);
        const mixed = [...one.calls, ...two.calls];

        await expect(store.createProposal(proposalInput(one.dispatch.id, mixed))).rejects.toThrow(
          /mixes Dispatches/,
        );
        expect(await store.listUnproposed('solana', 100)).toHaveLength(2);
        expect(await store.listProposalsForDispatch(one.dispatch.id)).toEqual([]);
      });

      it('rejects a proposalRef already in use, leaving the Calls UNPROPOSED', async () => {
        const store = makeStore();
        const one = await seedUnproposed(store, 'solana', 1);
        const two = await seedUnproposed(store, 'solana', 1);
        await store.createProposal(proposalInput(one.dispatch.id, one.calls, { proposalRef: 'x' }));

        await expect(
          store.createProposal(proposalInput(two.dispatch.id, two.calls, { proposalRef: 'x' })),
        ).rejects.toThrow();
        expect(await store.listUnproposed('solana', 100)).toHaveLength(1);
      });

      it('keeps one Solana sequence per sender, but lets a Safe nonce be reused', async () => {
        const store = makeStore();
        const one = await seedUnproposed(store, 'solana', 1);
        const two = await seedUnproposed(store, 'solana', 1);
        const three = await seedUnproposed(store, 'solana', 1);
        await store.createProposal(proposalInput(one.dispatch.id, one.calls, { sequence: 5 }));

        await expect(
          store.createProposal(proposalInput(two.dispatch.id, two.calls, { sequence: 5 })),
        ).rejects.toThrow();
        // Another sender has its own sequence.
        await store.createProposal(
          proposalInput(three.dispatch.id, three.calls, { sequence: 5, senderAddress: 'vault-2' }),
        );

        const safeOne = await seedUnproposed(store, 'base', 1);
        const safeTwo = await seedUnproposed(store, 'base', 1);
        const safeRef = (n: number): ChainProposalRef => ({
          kind: 'safe',
          safe: '0xsafe',
          safeTxHash: `0xhash${n}`,
          nonce: 9,
        });
        for (const [n, seeded] of [safeOne, safeTwo].entries()) {
          await store.createProposal(
            proposalInput(seeded.dispatch.id, seeded.calls, {
              chain: 'base',
              senderAddress: '0xsafe',
              sequence: 9,
              chainRef: safeRef(n),
              proposalRef: `0xhash${n}`,
            }),
          );
        }
      });
    });

    describe('listProposalsDue / updateProposal', () => {
      it('returns unresolved Proposals on the asked chains whose check is due, most overdue first', async () => {
        const store = makeStore();
        const a = await seedUnproposed(store, 'solana', 1);
        const b = await seedUnproposed(store, 'solana', 1);
        const c = await seedUnproposed(store, 'solana', 1);
        const d = await seedUnproposed(store, 'base', 1);
        const now = new Date();
        const pa = await store.createProposal(proposalInput(a.dispatch.id, a.calls));
        const pb = await store.createProposal(proposalInput(b.dispatch.id, b.calls));
        const pc = await store.createProposal(proposalInput(c.dispatch.id, c.calls));
        await store.createProposal(proposalInput(d.dispatch.id, d.calls, { chain: 'base' }));

        await store.updateProposal(pa.id, { nextCheckAt: new Date(now.getTime() - 1_000) });
        await store.updateProposal(pb.id, { nextCheckAt: new Date(now.getTime() - 5_000) });
        await store.updateProposal(pc.id, { nextCheckAt: new Date(now.getTime() + 60_000) });

        const due = await store.listProposalsDue(['solana'], now, 100);
        expect(due.map((p) => p.id)).toEqual([pb.id, pa.id]);
        expect(await store.listProposalsDue(['solana'], now, 1)).toHaveLength(1);

        await store.updateProposal(pb.id, { phase: 'resolved' });
        expect((await store.listProposalsDue(['solana'], now, 100)).map((p) => p.id)).toEqual([
          pa.id,
        ]);
      });

      it('applies a patch and leaves the rest alone', async () => {
        const store = makeStore();
        const seeded = await seedUnproposed(store, 'solana', 1);
        const proposal = await store.createProposal(
          proposalInput(seeded.dispatch.id, seeded.calls),
        );
        const executeAfter = new Date(Date.now() + 1_000);

        const updated = await store.updateProposal(proposal.id, {
          phase: 'open',
          approvals: 1,
          approvalState: 'approved',
          executeAfter,
          checkFailures: 3,
        });

        expect(updated).toMatchObject({
          phase: 'open',
          approvals: 1,
          approvalState: 'approved',
          executeAfter,
          checkFailures: 3,
          proposalRef: proposal.proposalRef,
          nextCheckAt: proposal.nextCheckAt,
        });
        expect(await store.getProposal(proposal.id)).toEqual(updated);
        await expect(
          store.updateProposal('00000000-0000-4000-8000-000000000000', {}),
        ).rejects.toThrow();
      });
    });

    describe('execution', () => {
      async function openProposal(store: DispatchStore) {
        const seeded = await seedUnproposed(store, 'solana', 2);
        const proposal = await store.createProposal(
          proposalInput(seeded.dispatch.id, seeded.calls),
        );
        await store.updateProposal(proposal.id, { phase: 'open', approvalState: 'approved' });
        return { ...seeded, proposal };
      }

      it('markProposalExecuting moves the Calls to PENDING, sharing one hash, before the send', async () => {
        const store = makeStore();
        const { proposal } = await openProposal(store);

        const executing = await store.markProposalExecuting(proposal.id, 'exec-bytes', 'exec-hash');

        expect(executing).toHaveLength(2);
        for (const call of executing) {
          expect(call).toMatchObject({
            status: 'PENDING',
            hash: 'exec-hash',
            signedBytes: 'exec-bytes',
            proposalId: proposal.id,
          });
          expect(call.broadcastAt).not.toBeNull();
          expect(call.lastBroadcastAt).not.toBeNull();
        }
        expect((await store.getProposal(proposal.id))?.phase).toBe('executing');
        expect(await store.listTransactionsByHash('exec-hash')).toHaveLength(2);
        await expect(store.markProposalExecuting(proposal.id, 'again', 'again')).rejects.toThrow();
      });

      it('reopenProposalForExecution returns FAILED Calls to AWAITING_APPROVAL with no hash', async () => {
        const store = makeStore();
        const { proposal } = await openProposal(store);
        const executing = await store.markProposalExecuting(proposal.id, 'exec-bytes', 'exec-hash');

        // Only a failed execute can be reopened.
        await expect(store.reopenProposalForExecution(proposal.id)).rejects.toThrow();

        for (const call of executing) {
          await store.markFailed(call.id, { code: 'CHAIN_REJECTED', message: 'reverted' });
        }
        const reopened = await store.reopenProposalForExecution(proposal.id);

        expect(reopened).toHaveLength(2);
        for (const call of reopened) {
          expect(call).toMatchObject({
            status: 'AWAITING_APPROVAL',
            hash: null,
            signedBytes: null,
            error: null,
            proposalId: proposal.id,
          });
        }
        const after = await store.getProposal(proposal.id);
        expect(after?.phase).toBe('open');
        expect(after?.nextCheckAt.getTime()).toBeGreaterThanOrEqual(proposal.nextCheckAt.getTime());
      });

      it('keeps a fee-bumped execute transaction in its Proposal, as the Call`s one current version', async () => {
        const store = makeStore();
        const { proposal } = await openProposal(store);
        const [first] = await store.markProposalExecuting(proposal.id, 'exec-bytes', 'exec-hash');
        if (!first) throw new Error('no Call');

        const replacement = await store.createReplacementTransaction(first.id, {
          signedBytes: 'bumped-bytes',
          hash: 'bumped-hash',
        });

        expect(replacement).toMatchObject({
          proposalId: proposal.id,
          proposalPosition: first.proposalPosition,
        });
        const calls = await store.listProposalCalls(proposal.id);
        expect(calls.map((c) => c.hash)).toEqual(
          calls.map((c) => (c.id === replacement.id ? 'bumped-hash' : 'exec-hash')),
        );
        expect(calls).toHaveLength(2);
        expect(calls.some((c) => c.id === first.id)).toBe(false);
      });
    });

    describe('settleProposal', () => {
      async function awaiting(store: DispatchStore) {
        const seeded = await seedUnproposed(store, 'solana', 2);
        const proposal = await store.createProposal(
          proposalInput(seeded.dispatch.id, seeded.calls),
        );
        return { ...seeded, proposal };
      }

      it('FAILED with APPROVAL_REJECTED fails every Call and resolves the Proposal', async () => {
        const store = makeStore();
        const { dispatch, proposal } = await awaiting(store);
        const error = { code: 'APPROVAL_REJECTED', message: 'rejected' } as const;

        const settled = await store.settleProposal(proposal.id, { status: 'FAILED', error });

        expect(settled.map((c) => [c.status, c.error, c.hash])).toEqual([
          ['FAILED', error, null],
          ['FAILED', error, null],
        ]);
        expect((await store.listTransactions(dispatch.id)).map((c) => c.status)).toEqual([
          'FAILED',
          'FAILED',
        ]);
        const after = await store.getProposal(proposal.id);
        expect(after?.phase).toBe('resolved');
        expect(after?.resolvedAt).not.toBeNull();
      });

      it('ABANDONED with APPROVAL_TIMEOUT times the Proposal out, and a hashless Call is never re-watched', async () => {
        const store = makeStore();
        const { proposal } = await awaiting(store);
        const error = { code: 'APPROVAL_TIMEOUT', message: 'no decision' } as const;

        const settled = await store.settleProposal(proposal.id, { status: 'ABANDONED', error });

        for (const call of settled) {
          expect(call).toMatchObject({ status: 'ABANDONED', error, hash: null });
          expect(call.abandonedAt).not.toBeNull();
        }
        const after = await store.getProposal(proposal.id);
        expect(after?.phase).toBe('timed_out');
        expect(after?.timedOutAt).not.toBeNull();
        expect(await store.listAbandonedTransactions(['solana'], 100, PAST)).toEqual([]);
      });

      it('a timed-out Proposal can still settle CONFIRMED with the hash someone else executed it under', async () => {
        const store = makeStore();
        const { proposal } = await awaiting(store);
        await store.settleProposal(proposal.id, {
          status: 'ABANDONED',
          error: { code: 'APPROVAL_TIMEOUT', message: 'no decision' },
        });

        const settled = await store.settleProposal(proposal.id, {
          status: 'CONFIRMED',
          hash: 'late-hash',
        });

        for (const call of settled) {
          expect(call).toMatchObject({ status: 'CONFIRMED', hash: 'late-hash', error: null });
          expect(call.confirmedAt).not.toBeNull();
        }
        expect((await store.getProposal(proposal.id))?.phase).toBe('resolved');
        expect(await store.listProposalCalls(proposal.id)).toHaveLength(2);
      });

      it('leaves each Call`s hash alone when the outcome names none, and skips REPLACED versions', async () => {
        const store = makeStore();
        const seeded = await seedUnproposed(store, 'solana', 1);
        const proposal = await store.createProposal(
          proposalInput(seeded.dispatch.id, seeded.calls),
        );
        const [executing] = await store.markProposalExecuting(proposal.id, 'bytes', 'hash-1');
        if (!executing) throw new Error('no Call');
        const replacement = await store.createReplacementTransaction(executing.id, {
          signedBytes: 'bytes-2',
          hash: 'hash-2',
        });

        const settled = await store.settleProposal(proposal.id, { status: 'CONFIRMED' });

        expect(settled.map((c) => [c.id, c.hash])).toEqual([[replacement.id, 'hash-2']]);
        const all = await store.listTransactions(seeded.dispatch.id);
        expect(all.find((c) => c.id === executing.id)?.status).toBe('REPLACED');
      });

      it('rejects an unknown Proposal', async () => {
        const store = makeStore();
        await expect(
          store.settleProposal('00000000-0000-4000-8000-000000000000', { status: 'FAILED' }),
        ).rejects.toThrow();
      });
    });

    describe('markAbandoned / listAbandonedTransactions', () => {
      it('records the error when given, and leaves it alone when not', async () => {
        const store = makeStore();
        const dispatch = await store.createDispatch({
          chain: 'solana',
          idempotencyKey: `k-${counter++}`,
          items: [solanaItem('1')],
          retryPolicy: false,
        });
        const withError = await store.createTransaction({
          dispatchId: dispatch.id,
          callIndex: 0,
          chain: 'solana',
          signedBytes: 'b1',
          hash: 'h1',
        });
        const without = await store.createTransaction({
          dispatchId: dispatch.id,
          callIndex: 0,
          chain: 'solana',
          signedBytes: 'b2',
          hash: 'h2',
        });
        const error = { code: 'APPROVAL_TIMEOUT', message: 'late' } as const;

        await store.markAbandoned(withError.id, error);
        await store.markAbandoned(without.id);

        const rows = await store.listTransactions(dispatch.id);
        expect(rows.find((r) => r.id === withError.id)).toMatchObject({
          status: 'ABANDONED',
          error,
        });
        expect(rows.find((r) => r.id === without.id)).toMatchObject({
          status: 'ABANDONED',
          error: null,
        });
        // Both have hashes, so both are still re-watched, as before.
        expect(await store.listAbandonedTransactions(['solana'], 100, PAST)).toHaveLength(2);
      });
    });

    describe('listCommitted', () => {
      it('totals in-flight and recently timed-out Proposals, plus UNPROPOSED payments for the sender', async () => {
        const store = makeStore();
        // 10 + 20 USDC, UNPROPOSED.
        await seedUnproposed(store, 'solana', 2);
        // 30 USDC / 5 SOL noted.
        const noted = await seedUnproposed(store, 'solana', 1);
        await store.createProposal(proposalInput(noted.dispatch.id, noted.calls));
        // Resolved: no longer held back.
        const done = await seedUnproposed(store, 'solana', 1);
        const resolved = await store.createProposal(proposalInput(done.dispatch.id, done.calls));
        await store.settleProposal(resolved.id, { status: 'CONFIRMED', hash: 'h' });
        // Timed out just now, so inside any window that starts earlier.
        const late = await seedUnproposed(store, 'solana', 1);
        const timedOut = await store.createProposal(proposalInput(late.dispatch.id, late.calls));
        await store.settleProposal(timedOut.id, {
          status: 'ABANDONED',
          error: { code: 'APPROVAL_TIMEOUT', message: 'late' },
        });
        // Another chain's Proposal is never counted.
        const other = await seedUnproposed(store, 'base', 1);
        await store.createProposal(
          proposalInput(other.dispatch.id, other.calls, { chain: 'base' }),
        );

        const since = new Date(Date.now() - 60_000);
        const sender = await store.listCommitted('solana', 'sender', since);
        // Proposals: noted 30 + timed_out 30. UNPROPOSED: 10 + 20 (first seed). The three
        // single-item seeds' Calls were all moved into Proposals, so none count twice.
        expect(sender).toEqual([{ asset: 'USDC', amount: '90' }]);
        expect(await store.listCommitted('solana', 'proposer', since)).toEqual([
          { asset: 'SOL', amount: '10' },
        ]);

        // Outside the window the timed-out Proposal drops out.
        const future = new Date(Date.now() + 60_000);
        expect(await store.listCommitted('solana', 'sender', future)).toEqual([
          { asset: 'USDC', amount: '60' },
        ]);
        expect(await store.listCommitted('solana', 'proposer', future)).toEqual([
          { asset: 'SOL', amount: '5' },
        ]);
      });

      it('is empty when nothing is committed', async () => {
        const store = makeStore();
        expect(await store.listCommitted('solana', 'sender', PAST)).toEqual([]);
        expect(await store.listCommitted('solana', 'proposer', PAST)).toEqual([]);
      });
    });

    describe('listProposalsForDispatch', () => {
      it('returns only that Dispatch`s Proposals, oldest first', async () => {
        const store = makeStore();
        const one = await seedUnproposed(store, 'solana', 2);
        const other = await seedUnproposed(store, 'solana', 1);
        const [a, b] = one.calls as [Transaction, Transaction];
        const first = await store.createProposal(proposalInput(one.dispatch.id, [a]));
        const second = await store.createProposal(proposalInput(one.dispatch.id, [b]));
        await store.createProposal(proposalInput(other.dispatch.id, other.calls));

        const listed = await store.listProposalsForDispatch(one.dispatch.id);
        expect(listed.map((p) => p.id)).toEqual([first.id, second.id]);
        expect(
          await store.listProposalsForDispatch('00000000-0000-4000-8000-000000000000'),
        ).toEqual([]);
      });
    });
  });
}
