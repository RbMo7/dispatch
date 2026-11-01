import { describe, expect, it } from 'vitest';

import { parseDetail, parsePage } from '../console/api/parse';
import type { Chain, Network } from './chains';
import type { LoadedDispatch } from './dispatch';
import { dispatchFlow as flowOn, type FlowClock } from './dispatchFlow';
import type { Flow, Stage } from './flow';

const clock = (now: string) => ({
  now: new Date(now),
  time: (at: Date) => at.toISOString().slice(11, 19),
});

const ID = '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6';
const RECIPIENT = '0x4c1e2f0a9b7d3e5c8a6f1b2d4e9c0a7f3b5d9a07';
const H_AA = '0xaa1f5e0c3b2d7a9e4f6c8b1d0e2a3f5c7b9d1e3f5a7c9e1b3d5f7a9c1e3b5d7f';
const H_BB = '0xbb4c2d9e7f1a3b5c8d0e2f4a6b8c1d3e5f7a9b2c4d6e8f0a1b3c5d7e9f2a4b6c';

/** A `GET /v1/dispatches` row and a `GET /v1/dispatch/:id?include=timeline` body, through the real parser. */
function load(
  row: { chain: Chain; createdAt: string; [field: string]: unknown },
  body: object,
): LoadedDispatch {
  const page = parsePage({ dispatches: [{ dispatchId: ID, ...row }], nextCursor: null });
  const { chain, createdAt } = row;
  return {
    summary: page.dispatches[0]!,
    detail: parseDetail({ dispatchId: ID, chain, createdAt, ...body }),
  };
}

const MAINNET: Record<Chain, Network> = { solana: 'mainnet-beta', base: 'base' };

/** The flow as an engine on each chain's mainnet would show it. */
const dispatchFlow = (loaded: LoadedDispatch, at: FlowClock, network?: Network) =>
  flowOn(loaded, at, network ?? MAINNET[loaded.summary.chain]);

const usdc = (amount: string, extra: object = {}) => ({
  type: 'payment',
  recipient: RECIPIENT,
  asset: 'USDC',
  decimals: 6,
  amount,
  ...extra,
});

const main = (flow: Flow) =>
  flow.stages.filter((s) => !s.kind.startsWith('branch')).map((s) => `${s.kind} ${s.title}`);
const branches = (flow: Flow) => flow.stages.filter((s) => s.kind.startsWith('branch'));
const end = (flow: Flow) => flow.stages.at(-1)!;
const titled = (flow: Flow, title: string): Stage => flow.stages.find((s) => s.title === title)!;

describe('the flow of one Dispatch', () => {
  it('runs a plain payment from submitted to its confirmed hash', () => {
    const loaded = load(
      {
        mode: 'managed',
        chain: 'base',
        status: 'confirmed',
        createdAt: '2026-10-31T10:00:00.000Z',
        itemCount: 1,
        totals: [{ asset: 'USDC', decimals: 6, amount: '25000000' }],
      },
      {
        mode: 'managed',
        status: 'confirmed',
        items: [usdc('25000000', { status: 'confirmed', transactionHash: H_AA, error: null })],
        timeline: [
          { at: '2026-10-31T10:00:00.000Z', kind: 'created' },
          { at: '2026-10-31T10:00:01.200Z', kind: 'claimed' },
          {
            at: '2026-10-31T10:00:01.900Z',
            kind: 'written',
            hash: H_AA,
            items: [0],
            replaces: null,
          },
          { at: '2026-10-31T10:00:02.300Z', kind: 'sent', hash: H_AA, items: [0] },
          { at: '2026-10-31T10:00:20.000Z', kind: 'confirmed', hash: H_AA, items: [0] },
        ],
      },
    );
    const flow = dispatchFlow(loaded, clock('2026-10-31T11:00:00Z'));
    expect(main(flow)).toEqual([
      'done Submitted',
      'done Claimed',
      'done Signed and sent',
      'done Confirmed',
      'end-done Transaction hash',
    ]);
    expect(branches(flow)).toEqual([]);
    expect(flow.summary).toBe('Done in 20 s');
    expect(flow.elapsed).toBe('Confirmed at 10:00:20');
    expect(end(flow).hash).toBe(H_AA);
    expect(end(flow).links).toEqual([
      { label: 'View on Basescan', href: `https://basescan.org/tx/${H_AA}` },
    ]);
    expect(end(dispatchFlow(loaded, clock('2026-10-31T11:00:00Z'), 'base-sepolia')).links).toEqual([
      { label: 'View on Basescan', href: `https://sepolia.basescan.org/tx/${H_AA}` },
    ]);
    expect(end(dispatchFlow(loaded, clock('2026-10-31T11:00:00Z'), 'unknown')).links).toEqual([]);
    expect(flow.stages[0]!.detail).toEqual([
      '1 payment',
      ', ',
      { asset: 'USDC', decimals: 6, raw: '25000000' },
    ]);
  });

  it('branches off a fee bump and ends at the version that landed', () => {
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'confirmed',
          createdAt: '2026-10-31T10:00:00.000Z',
          itemCount: 1,
          totals: [{ asset: 'USDC', decimals: 6, amount: '25000000' }],
        },
        {
          mode: 'managed',
          status: 'confirmed',
          items: [usdc('25000000', { status: 'confirmed', transactionHash: H_BB, error: null })],
          timeline: [
            { at: '2026-10-31T10:00:00.000Z', kind: 'created' },
            { at: '2026-10-31T10:00:01.200Z', kind: 'claimed' },
            {
              at: '2026-10-31T10:00:01.900Z',
              kind: 'written',
              hash: H_AA,
              items: [0],
              replaces: null,
            },
            {
              at: '2026-10-31T10:01:02.000Z',
              kind: 'attempt',
              hash: H_AA,
              items: [0],
              error: null,
            },
            {
              at: '2026-10-31T10:02:03.000Z',
              kind: 'written',
              hash: H_BB,
              items: [0],
              replaces: H_AA,
            },
            {
              at: '2026-10-31T10:02:03.000Z',
              kind: 'replaced',
              hash: H_AA,
              items: [0],
              by: H_BB,
            },
            { at: '2026-10-31T10:02:03.400Z', kind: 'sent', hash: H_BB, items: [0] },
            { at: '2026-10-31T10:02:20.000Z', kind: 'confirmed', hash: H_BB, items: [0] },
            { at: '2026-10-31T10:02:20.000Z', kind: 'dropped', hash: H_AA, items: [0], by: H_BB },
          ],
        },
      ),
      clock('2026-10-31T11:00:00Z'),
    );
    const [bump] = branches(flow);
    expect(bump).toMatchObject({ kind: 'branch-done', title: 'Fee bumped', at: '10:02:03' });
    expect(bump!.detail).toBe(
      'No block in time, so it was repriced at the same nonce: 0xaa1f…5d7f replaced by 0xbb4c…4b6c.',
    );
    expect(titled(flow, 'Signed and sent').detail).toBe(
      '1 transaction, sent again 1 time while waiting',
    );
    expect(end(flow)).toMatchObject({ kind: 'end-done', hash: H_BB });
  });

  it('branches off a Solana resubmission after its blockhash expired', () => {
    const SIG_1 =
      '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi3h5qzFbfmEgEqFhJ1Vm2nQ7yRq1zD3sG8kPxAqV2oYcT';
    const SIG_2 =
      '2nBhEBYYvfaAe16UMNqRHre4YNSskvuYgx3M6E4JP1oDYvZEJHvoPzyUidNgNX5r9sTyN1J9UDtRqbmSUkN2LmXC';
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'solana',
          status: 'confirmed',
          createdAt: '2026-10-31T10:00:00.000Z',
          itemCount: 1,
          totals: [{ asset: 'SOL', decimals: 9, amount: '50000000' }],
        },
        {
          mode: 'managed',
          status: 'confirmed',
          items: [
            {
              type: 'payment',
              recipient: '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a',
              asset: 'SOL',
              decimals: 9,
              amount: '50000000',
              status: 'confirmed',
              transactionHash: SIG_2,
              error: null,
            },
          ],
          timeline: [
            { at: '2026-10-31T10:00:00.000Z', kind: 'created' },
            { at: '2026-10-31T10:00:00.800Z', kind: 'claimed' },
            {
              at: '2026-10-31T10:00:01.100Z',
              kind: 'written',
              hash: SIG_1,
              items: [0],
              replaces: null,
            },
            {
              at: '2026-10-31T10:01:35.000Z',
              kind: 'written',
              hash: SIG_2,
              items: [0],
              replaces: SIG_1,
            },
            { at: '2026-10-31T10:01:35.000Z', kind: 'dropped', hash: SIG_1, items: [0], by: SIG_2 },
            { at: '2026-10-31T10:01:37.500Z', kind: 'confirmed', hash: SIG_2, items: [0] },
          ],
        },
      ),
      clock('2026-10-31T11:00:00Z'),
    );
    expect(branches(flow).map((s) => `${s.kind} ${s.title}`)).toEqual(['branch-done Resubmitted']);
    expect(end(flow).links).toEqual([
      { label: 'View on Solscan', href: `https://solscan.io/tx/${SIG_2}` },
    ]);
  });

  it('waits on Approvers for a Multisig Sender, with the deadline and a link to Squads', () => {
    const chainRef = {
      kind: 'squads',
      multisig: 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv',
      proposal: '8xQyR1sT2uV3wX4yZ5a6B7c8D9e1F2g3H4i5J6k7L8m9',
      transactionIndex: 4,
    };
    const approvers = [
      {
        address: 'HvT3kLm9qPz2Rb8sWc4xYd7eFg1hJn5oKp6uVa2bCd3E',
        label: 'Priya',
        decision: 'approved',
      },
      { address: '7sWq2Rt5yUi8oPa1sDf4gHj6kLz9xCv3bNm2QwE5rTy8', decision: 'pending' },
      { address: '4dFg7hJk1lZx3cVb6nMq9wEr2tYu5iOp8aSd1fGh4jKl', decision: 'rejected' },
      { address: '9mNb2vCx5zLk8jHg1fDs4aPo7iUy3tRe6wQq9sDf2gHj', decision: 'pending' },
    ];
    const approval = {
      state: 'awaiting',
      approvals: 1,
      threshold: 3,
      remaining: 2,
      approvers,
      deadline: '2026-10-24T12:00:00.000Z',
      expected: { recipients: 2, totals: [{ asset: 'USDC', amount: '30' }] },
      chainRef,
    };
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'solana',
          status: 'broadcasting',
          createdAt: '2026-10-21T12:00:00.000Z',
          itemCount: 2,
          totals: [{ asset: 'USDC', decimals: 6, amount: '30' }],
        },
        {
          mode: 'managed',
          status: 'broadcasting',
          items: [
            usdc('15', {
              recipient: chainRef.multisig,
              status: 'awaiting_approval',
              transactionHash: null,
              error: null,
              approval,
            }),
            usdc('15', {
              recipient: chainRef.proposal,
              status: 'awaiting_approval',
              transactionHash: null,
              error: null,
              approval,
            }),
          ],
          timeline: [
            { at: '2026-10-21T12:00:00.000Z', kind: 'created' },
            { at: '2026-10-21T12:00:01.000Z', kind: 'claimed' },
            {
              at: '2026-10-21T12:00:03.000Z',
              kind: 'proposal_created',
              proposalId: 'p-1',
              chainRef,
              items: [0, 1],
            },
            {
              at: null,
              kind: 'proposal_approval',
              proposalId: 'p-1',
              state: 'awaiting',
              approvals: 1,
              threshold: 3,
            },
          ],
        },
      ),
      clock('2026-10-22T10:00:00Z'),
    );
    expect(main(flow)).toEqual([
      'done Submitted',
      'done Claimed',
      'done Proposed',
      'current 1 of 3 approved, 2 more needed',
      'todo Executed',
      'todo Confirmed',
      'end-todo Transaction hash',
    ]);
    expect(flow.summary).toBe('Stage 4 of 7, waiting on Approvers');
    const approvals = titled(flow, '1 of 3 approved, 2 more needed');
    expect(approvals.detail).toBe('Deadline 12:00:00, in 2 days. The engine never approves.');
    expect(approvals.approvers).toEqual([
      { address: approvers[0]!.address, label: 'Priya', decision: 'approved' },
      { address: approvers[1]!.address, label: null, decision: 'pending' },
      { address: approvers[2]!.address, label: null, decision: 'rejected' },
      { address: approvers[3]!.address, label: null, decision: 'pending' },
    ]);
    expect(approvals.links).toEqual([
      {
        label: 'Open #4 in Squads',
        href: `https://app.squads.so/squads/${chainRef.multisig}/transactions`,
      },
    ]);
    expect(end(flow).detail).toBe('Appears after execution');
  });

  it('holds a Dispatch that matched a Flag Rule, with nothing past it reached', () => {
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'held',
          createdAt: '2026-10-31T09:15:22.000Z',
          itemCount: 1,
          totals: [{ asset: 'USDC', decimals: 6, amount: '3215500000' }],
        },
        {
          mode: 'managed',
          status: 'held',
          items: [usdc('3215500000', { status: 'queued', transactionHash: null, error: null })],
          timeline: [{ at: '2026-10-31T09:15:22.000Z', kind: 'created' }],
        },
      ),
      clock('2026-10-31T14:13:22Z'),
    );
    expect(main(flow)).toEqual([
      'done Submitted',
      'current Held',
      'todo Claimed',
      'todo Signed and sent',
      'todo Confirmed',
      'end-todo Transaction hash',
    ]);
    expect(flow.elapsed).toBe('Held for 4 h 58 min');
  });

  it('branches off failed items of a partial Dispatch and counts the hashes that landed', () => {
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'partial',
          createdAt: '2026-10-31T10:00:00.000Z',
          itemCount: 3,
          totals: [{ asset: 'USDC', decimals: 6, amount: '25000000' }],
        },
        {
          mode: 'managed',
          status: 'partial',
          items: [
            usdc('10000000', { status: 'confirmed', transactionHash: H_AA, error: null }),
            usdc('10000000', {
              status: 'failed',
              transactionHash: null,
              error: { code: 'INVALID_RECIPIENT', message: 'The address is the zero address.' },
            }),
            usdc('5000000', { status: 'confirmed', transactionHash: H_BB, error: null }),
          ],
          timeline: [
            { at: '2026-10-31T10:00:00.000Z', kind: 'created' },
            { at: '2026-10-31T10:00:01.000Z', kind: 'claimed' },
            {
              at: '2026-10-31T10:00:01.500Z',
              kind: 'failed',
              hash: null,
              items: [1],
              error: { code: 'INVALID_RECIPIENT', message: 'The address is the zero address.' },
            },
            {
              at: '2026-10-31T10:00:02.000Z',
              kind: 'written',
              hash: H_AA,
              items: [0],
              replaces: null,
            },
            {
              at: '2026-10-31T10:00:02.500Z',
              kind: 'written',
              hash: H_BB,
              items: [2],
              replaces: null,
            },
            { at: '2026-10-31T10:00:15.000Z', kind: 'confirmed', hash: H_AA, items: [0] },
            { at: '2026-10-31T10:00:17.000Z', kind: 'confirmed', hash: H_BB, items: [2] },
          ],
        },
      ),
      clock('2026-10-31T11:00:00Z'),
    );
    expect(branches(flow)).toEqual([
      {
        kind: 'branch-failed',
        title: 'Item failures, 1',
        at: '10:00:01',
        detail: 'The address is the zero address. Fix the address and send it again.',
        links: [{ label: 'Show in Items', items: 'failed' }],
      },
    ]);
    expect(titled(flow, 'Confirmed').count).toEqual({ reached: 2, of: 3 });
    expect(end(flow)).toMatchObject({
      kind: 'end-done',
      title: '2 transaction hashes',
      hash: H_AA,
    });
    expect(flow.summary).toBe('2 of 3 confirmed');
  });

  it('ends an expired Relay Dispatch with no transaction landed', () => {
    const SIG =
      '5h2kXUzWZ3nLcVJd8gVQe1tBp4Ry7mN6oAsF9wT2xKbE3uHqL8vC1dP5yR6zS4aG7jM9nB2cX3fV5gH8kJ1lQ4wE';
    const flow = dispatchFlow(
      load(
        {
          mode: 'relay',
          chain: 'solana',
          status: 'failed',
          transactionHash: SIG,
          error: null,
          createdAt: '2026-10-30T12:20:02.000Z',
          itemCount: 1,
          totals: [],
        },
        {
          mode: 'relay',
          status: 'failed',
          transactionHash: SIG,
          error: {
            code: 'CHAIN_REJECTED',
            message: 'solana transaction expired without landing and was not resubmitted',
          },
          timeline: [
            { at: '2026-10-30T12:20:02.000Z', kind: 'created' },
            { at: '2026-10-30T12:20:02.400Z', kind: 'claimed' },
            {
              at: '2026-10-30T12:20:02.900Z',
              kind: 'written',
              hash: SIG,
              items: [0],
              replaces: null,
            },
            { at: '2026-10-30T12:20:40.000Z', kind: 'attempt', hash: SIG, items: [0], error: null },
            {
              at: '2026-10-30T12:21:33.000Z',
              kind: 'failed',
              hash: SIG,
              items: [0],
              error: {
                code: 'CHAIN_REJECTED',
                message: 'solana transaction expired without landing and was not resubmitted',
              },
            },
          ],
        },
      ),
      clock('2026-10-31T11:00:00Z'),
    );
    expect(main(flow)).toEqual([
      'done Received',
      'done Claimed',
      'done Sent',
      'failed Expired',
      'end-failed No transaction landed',
    ]);
    expect(flow.summary).toBe('Failed at stage 4 of 5');
    expect(end(flow).hash).toBeUndefined();
  });

  it('ends a cancelled Dispatch at the cancel, with nothing signed', () => {
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'cancelled',
          createdAt: '2026-10-30T10:04:51.000Z',
          itemCount: 1,
          totals: [{ asset: 'USDC', decimals: 6, amount: '1120000000' }],
        },
        {
          mode: 'managed',
          status: 'cancelled',
          items: [usdc('1120000000', { status: 'cancelled', transactionHash: null, error: null })],
          timeline: [
            { at: '2026-10-30T10:04:51.000Z', kind: 'created' },
            { at: '2026-10-30T10:06:10.000Z', kind: 'cancelled' },
          ],
          cancellation: {
            at: '2026-10-30T10:06:10.000Z',
            tokenKind: 'operator',
            reason: 'duplicate of refund 7730',
          },
        },
      ),
      clock('2026-10-31T11:00:00Z'),
    );
    expect(main(flow)).toEqual(['done Submitted', 'end-cancelled Cancelled']);
    expect(flow.elapsed).toBe('Ended at 10:06:10');
    expect(titled(flow, 'Cancelled').detail).toBe(
      'Withdrawn before the engine claimed it, so nothing was signed or sent. Cancelled with the operator token: duplicate of refund 7730.',
    );
  });

  it('abandons a Proposal nobody decided on, and says it may still be executed', () => {
    const chainRef = {
      kind: 'safe',
      safe: '0x9a07b5d93f7a0c9e4d2b1f6a8c5e3d0a2f1e2c4c',
      safeTxHash: H_AA,
      nonce: 12,
    };
    const timeout = {
      code: 'APPROVAL_TIMEOUT',
      message: 'Nobody decided on the Proposal by its deadline',
      chainDetail: { deadlineAt: '2026-10-24T12:00:00.000Z' },
    };
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'failed',
          createdAt: '2026-10-21T12:00:00.000Z',
          itemCount: 1,
          totals: [{ asset: 'USDC', decimals: 6, amount: '15000000' }],
        },
        {
          mode: 'managed',
          status: 'failed',
          items: [
            usdc('15000000', {
              status: 'abandoned',
              transactionHash: null,
              error: timeout,
              approval: {
                state: 'awaiting',
                approvals: 1,
                threshold: 2,
                remaining: 1,
                approvers: [
                  { address: '0x1f4a8b2c3d9e0f7a6b5c4d3e2f1a0b9c8d7e6f5a', decision: 'approved' },
                  { address: '0x2e5b9c3d4e0f1a8b7c6d5e4f3a2b1c0d9e8f7a6b', decision: 'pending' },
                ],
                deadline: '2026-10-24T12:00:00.000Z',
                expected: { recipients: 1, totals: [{ asset: 'USDC', amount: '15000000' }] },
                chainRef,
              },
            }),
          ],
          timeline: [
            { at: '2026-10-21T12:00:00.000Z', kind: 'created' },
            { at: '2026-10-21T12:00:01.000Z', kind: 'claimed' },
            {
              at: '2026-10-21T12:00:04.000Z',
              kind: 'proposal_created',
              proposalId: 'p-9',
              chainRef,
              items: [0],
            },
            {
              at: '2026-10-24T12:00:30.000Z',
              kind: 'abandoned',
              hash: null,
              items: [0],
              error: timeout,
            },
            {
              at: '2026-10-24T12:00:30.000Z',
              kind: 'proposal_approval',
              proposalId: 'p-9',
              state: 'awaiting',
              approvals: 1,
              threshold: 2,
            },
            { at: '2026-10-24T12:00:30.000Z', kind: 'proposal_timed_out', proposalId: 'p-9' },
          ],
        },
      ),
      clock('2026-10-31T11:00:00Z'),
    );
    expect(main(flow)).toEqual([
      'done Submitted',
      'done Claimed',
      'done Proposed',
      'failed Timed out',
      'todo Executed',
      'todo Confirmed',
      'end-failed No transaction landed',
    ]);
    expect(titled(flow, 'Timed out').detail).toContain(
      'may still be approved and executed in Safe',
    );
    expect(titled(flow, 'Timed out').approvers?.map((a) => a.decision)).toEqual([
      'approved',
      'pending',
    ]);
    expect(titled(flow, 'Timed out').links).toEqual([
      {
        label: 'Open nonce 12 in Safe',
        href: `https://app.safe.global/transactions/queue?safe=base:${chainRef.safe}`,
      },
    ]);
    expect(branches(flow)).toEqual([]);
  });

  it('names a Funding Check shortfall once, as an amount, when nothing was funded', () => {
    const short = {
      code: 'INSUFFICIENT_FUNDS',
      message: 'insufficient SOL balance',
      chainDetail: { asset: 'SOL', short: '11115845377' },
    };
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'solana',
          status: 'failed',
          createdAt: '2026-10-31T19:06:29.598Z',
          itemCount: 1,
          totals: [{ asset: 'SOL', decimals: 9, amount: '1000000' }],
        },
        {
          mode: 'managed',
          status: 'failed',
          items: [
            {
              type: 'payment',
              recipient: '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe',
              asset: 'SOL',
              decimals: 9,
              amount: '1000000',
              status: 'failed',
              transactionHash: null,
              error: short,
            },
          ],
          timeline: [
            { kind: 'created', at: '2026-10-31T19:06:29.598Z' },
            { kind: 'claimed', at: '2026-10-31T19:11:08.361Z' },
            {
              kind: 'failed',
              at: '2026-10-31T19:11:09.222Z',
              hash: null,
              items: [0],
              error: short,
            },
          ],
        },
      ),
      clock('2026-10-31T20:00:00Z'),
    );
    expect(main(flow)).toEqual([
      'done Submitted',
      'done Claimed',
      'todo Signed and sent',
      'failed Failed',
      'end-failed No transaction landed',
    ]);
    expect(branches(flow)).toEqual([]);
    expect(titled(flow, 'Failed').detail).toEqual([
      'The Sender is short ',
      { asset: 'SOL', raw: '11115845377', decimals: 9 },
      '. Nothing was signed.',
    ]);
    expect(titled(flow, 'Failed').links).toEqual([
      { label: 'Open Senders & Keys', href: '/console/senders' },
    ]);
  });

  it('waits for the worker while a Dispatch is unclaimed', () => {
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'queued',
          createdAt: '2026-10-31T10:00:00.000Z',
          itemCount: 1,
          totals: [{ asset: 'USDC', decimals: 6, amount: '1' }],
        },
        {
          mode: 'managed',
          status: 'queued',
          items: [usdc('1', { status: 'queued', transactionHash: null, error: null })],
          timeline: [{ at: '2026-10-31T10:00:00.000Z', kind: 'created' }],
        },
      ),
      clock('2026-10-31T10:02:30Z'),
    );
    expect(main(flow)).toEqual([
      'done Submitted',
      'current Waiting to be claimed',
      'todo Signed and sent',
      'todo Confirmed',
      'end-todo Transaction hash',
    ]);
    expect(flow.summary).toBe('Stage 2 of 5, waiting for the worker');
    expect(flow.elapsed).toBe('2 min 30 s so far');
  });

  it('aggregates a thousand payments by count, never by item', () => {
    const items: object[] = [];
    const timeline: object[] = [
      { at: '2026-10-31T13:20:04.000Z', kind: 'created' },
      { at: '2026-10-31T13:20:05.000Z', kind: 'claimed' },
    ];
    const hash = (i: number) => `0x${i.toString(16).padStart(64, '0')}`;
    for (let i = 0; i < 1000; i++) {
      const status =
        i < 612 ? 'confirmed' : i < 637 ? 'broadcasting' : i < 640 ? 'failed' : 'queued';
      const sent = status !== 'queued';
      items.push(
        usdc('184326710', {
          status,
          transactionHash: sent ? hash(i) : null,
          error:
            status === 'failed' ? { code: 'CHAIN_REJECTED', message: 'execution reverted' } : null,
        }),
      );
      if (sent) {
        timeline.push({
          at: '2026-10-31T13:21:00.000Z',
          kind: 'written',
          hash: hash(i),
          items: [i],
          replaces: null,
        });
      }
      if (status === 'confirmed') {
        timeline.push({
          at: '2026-10-31T13:22:00.000Z',
          kind: 'confirmed',
          hash: hash(i),
          items: [i],
        });
      }
      if (status === 'failed') {
        timeline.push({
          at: '2026-10-31T13:22:00.000Z',
          kind: 'failed',
          hash: hash(i),
          items: [i],
          error: { code: 'CHAIN_REJECTED', message: 'execution reverted' },
        });
      }
    }
    const started = performance.now();
    const flow = dispatchFlow(
      load(
        {
          mode: 'managed',
          chain: 'base',
          status: 'broadcasting',
          createdAt: '2026-10-31T13:20:04.000Z',
          itemCount: 1000,
          totals: [{ asset: 'USDC', decimals: 6, amount: '184326710000' }],
        },
        { mode: 'managed', status: 'broadcasting', items, timeline },
      ),
      clock('2026-10-31T14:03:52Z'),
    );
    expect(performance.now() - started).toBeLessThan(200);
    expect(titled(flow, 'Signed and sent')).toMatchObject({
      kind: 'current',
      count: { reached: 640, of: 1000 },
    });
    expect(titled(flow, 'Confirmed')).toMatchObject({
      kind: 'current',
      count: { reached: 612, of: 1000 },
    });
    expect(titled(flow, 'Item failures, 3').links).toEqual([
      { label: 'Show in Items', items: 'failed' },
    ]);
    expect(end(flow)).toMatchObject({
      kind: 'end-todo',
      title: 'Transaction hashes',
      detail: '612 landed so far. The first one:',
      hash: hash(0),
    });
    expect(flow.summary).toBe('Stage 3 of 5, 612 of 1,000 confirmed');
    expect(flow.elapsed).toBe('43 min 48 s so far');
  });
});
