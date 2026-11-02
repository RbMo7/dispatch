import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ApproverList } from '../components/ApproverList';
import { parseDetail } from '../console/api/parse';
import { approvalProgress, proposalApprovals } from './approval';

afterEach(cleanup);

const PRIYA = 'HvT3kLm9qPz2Rb8sWc4xYd7eFg1hJn5oKp6uVa2bCd3E';
const OSKAR = '7sWq2Rt5yUi8oPa1sDf4gHj6kLz9xCv3bNm2QwE5rTy8';

describe('approvalProgress', () => {
  it('says how many approved and how many more are needed', () => {
    expect(approvalProgress({ approvals: 1, threshold: 2, remaining: 1 })).toBe(
      '1 of 2 approved, 1 more needed',
    );
    expect(approvalProgress({ approvals: 0, threshold: 3, remaining: 3 })).toBe(
      '0 of 3 approved, 3 more needed',
    );
  });

  it('drops "more needed" once the threshold is met', () => {
    expect(approvalProgress({ approvals: 2, threshold: 2, remaining: 0 })).toBe('2 of 2 approved');
  });
});

describe('proposalApprovals', () => {
  const block = (proposal: string, approvals: number) => ({
    state: 'awaiting',
    approvals,
    threshold: 2,
    remaining: 2 - approvals,
    approvers: [
      { address: PRIYA, label: 'Priya', decision: approvals > 0 ? 'approved' : 'pending' },
    ],
    deadline: '2026-11-04T12:00:00.000Z',
    expected: { recipients: 1, totals: [] },
    chainRef: { kind: 'squads', multisig: 'ms', proposal, transactionIndex: 4 },
  });
  const item = (approval: object | undefined) => ({
    type: 'call',
    programId: 'prog',
    call: { target: 'prog', decoded: false, data: '' },
    status: approval ? 'awaiting_approval' : 'confirmed',
    transactionHash: null,
    error: null,
    ...(approval && { approval }),
  });

  it("groups a Dispatch's items by Proposal, in item order, from the API's own blocks", () => {
    const detail = parseDetail({
      dispatchId: '7f3a91c2-0b1e-4c55-9a7e-2d41f0c3b8e6',
      chain: 'solana',
      createdAt: '2026-11-01T10:00:00.000Z',
      mode: 'managed',
      status: 'broadcasting',
      items: [item(block('p-2', 1)), item(undefined), item(block('p-1', 0)), item(block('p-2', 1))],
      timeline: [],
    });
    if (detail.mode !== 'managed') throw new Error('managed');

    const grouped = proposalApprovals(detail.items);

    expect(grouped.map((p) => [p.approval.chainRef, p.items])).toEqual([
      [{ kind: 'squads', multisig: 'ms', proposal: 'p-2', transactionIndex: 4 }, [0, 3]],
      [{ kind: 'squads', multisig: 'ms', proposal: 'p-1', transactionIndex: 4 }, [2]],
    ]);
    expect(grouped[0]!.approval.approvers).toEqual([
      { address: PRIYA, label: 'Priya', decision: 'approved' },
    ]);
  });
});

describe('ApproverList', () => {
  it('names each Approver by label or short address, with the decision as a text-only pill', () => {
    render(
      <ApproverList
        approvers={[
          { address: PRIYA, label: 'Priya, finance', decision: 'approved' },
          { address: OSKAR, label: null, decision: 'pending' },
        ]}
      />,
    );
    const [first, second] = within(screen.getByRole('list', { name: 'Approvers' })).getAllByRole(
      'listitem',
    );
    expect(first!.textContent).toBe('Priya, financeHvT3…Cd3EApproved');
    expect(second!.textContent).toBe('7sWq…rTy8Pending');
    for (const row of [first!, second!]) {
      expect(row.querySelector('svg')).toBeNull();
    }
  });

  it('says when the engine has not read the Approvers yet', () => {
    render(<ApproverList approvers={[]} />);
    expect(screen.getByText('Approvers appear once the engine reads the Proposal.')).toBeTruthy();
  });
});
