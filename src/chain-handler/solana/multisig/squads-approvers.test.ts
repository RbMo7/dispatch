import { describe, expect, it } from 'vitest';

import { decodeMultisigAccount } from './multisig-account.js';
import { decodeProposalAccount, squadsApprovers } from './proposal-account.js';
import recorded from './squads-approvers-fixture.json' with { type: 'json' };

/** Account bytes read from devnet: a fresh 2-of-3 multisig whose first Voter had approved Proposal #1. */
const multisig = decodeMultisigAccount(Buffer.from(recorded.multisigBase64, 'base64'));
const proposal = decodeProposalAccount(Buffer.from(recorded.proposalBase64, 'base64'));
const [first, second, third] = recorded.voters as [string, string, string];

describe('squadsApprovers, from recorded devnet accounts', () => {
  it('lists the three Voters, never the engine member, with the one approval recorded on-chain', () => {
    const approvers = squadsApprovers(proposal, multisig);

    expect(approvers.map((a) => a.address).sort()).toEqual([first, second, third].sort());
    expect(approvers.map((a) => a.address)).not.toContain(recorded.member);
    expect(Object.fromEntries(approvers.map((a) => [a.address, a.decision]))).toEqual({
      [first]: 'approved',
      [second]: 'pending',
      [third]: 'pending',
    });
  });

  it('keeps the multisig account member order', () => {
    const voters = multisig.members.filter((m) => m.key !== recorded.member).map((m) => m.key);
    expect(squadsApprovers(proposal, multisig).map((a) => a.address)).toEqual(voters);
  });
});
