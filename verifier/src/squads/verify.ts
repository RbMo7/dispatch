import { compare, type Item } from '../compare.js';
import { RpcError } from '../errors.js';
import type { Payment } from '../payments.js';
import type { Report } from '../report.js';
import { decodeInstructions, type AccountReader } from './instructions.js';
import {
  SQUADS_PROGRAM_ID,
  decodeMultisig,
  decodeProposal,
  decodeVaultTransaction,
  proposalPda,
  transactionPda,
  vaultPda,
} from './layout.js';

export interface SquadsInput {
  /** The proposal account address the Approver is about to vote on. */
  proposal: string;
  payments: Payment[];
  read: AccountReader;
  /** Cluster genesis hash, when the RPC could tell us (printed so the Approver sees which network was read). */
  cluster?: string | undefined;
  programId?: string;
}

const iso = (seconds: bigint) =>
  new Date(Number(seconds) * 1000).toISOString().replace('.000Z', 'Z');

export async function verifySquads(input: SquadsInput): Promise<Report> {
  const programId = input.programId ?? SQUADS_PROGRAM_ID;
  const [proposalRaw] = await input.read([input.proposal]);
  if (!proposalRaw) {
    throw new RpcError(
      `proposal account ${input.proposal} does not exist on this cluster. It may be wrong, on another cluster, or already closed (executed, rejected or cancelled proposals can be closed by anyone); check its history on a block explorer.`,
    );
  }
  if (proposalRaw.owner !== programId) {
    throw new RpcError(
      `${input.proposal} is owned by ${proposalRaw.owner}, not by the Squads v4 program (${programId}): it is not a Squads proposal`,
    );
  }
  const proposal = decodeProposal(proposalRaw.data);
  if (proposalPda(proposal.multisig, proposal.transactionIndex, programId) !== input.proposal) {
    throw new RpcError(
      `${input.proposal} is not the proposal PDA for its own multisig and index: not a genuine Squads proposal`,
    );
  }

  const txAddress = transactionPda(proposal.multisig, proposal.transactionIndex, programId);
  const [txRaw, multisigRaw] = await input.read([txAddress, proposal.multisig]);
  if (!txRaw) {
    throw new RpcError(
      `the vault transaction ${txAddress} no longer exists (the proposal was closed), so its payments cannot be read; check the executed transaction on a block explorer instead`,
    );
  }
  if (txRaw.owner !== programId)
    throw new RpcError(`vault transaction ${txAddress} is not owned by the Squads v4 program`);
  const vt = decodeVaultTransaction(txRaw.data);
  if (vt.multisig !== proposal.multisig || vt.index !== proposal.transactionIndex) {
    throw new RpcError(
      'the vault transaction does not belong to this proposal (multisig or index differs)',
    );
  }
  const multisig =
    multisigRaw && multisigRaw.owner === programId ? decodeMultisig(multisigRaw.data) : null;
  const vault = vaultPda(proposal.multisig, vt.vaultIndex, programId);

  const decoded = await decodeInstructions(vt, vault, input.read);
  const problems = [...decoded.problems];
  const notes = [...decoded.notes];
  if (vt.ephemeralSigners > 0) {
    notes.push(
      `the vault transaction asks for ${vt.ephemeralSigners} ephemeral signer(s); no recognised payment uses them`,
    );
  }

  const proposalItems: Item[] = decoded.transfers.map((t) => ({
    recipient: t.recipient,
    asset: t.asset,
    amount: t.amount,
    position: t.instruction + 1,
  }));
  const fileItems: Item[] = input.payments.map((p) => ({
    recipient: p.recipient,
    asset: p.asset,
    amount: p.amount,
    position: p.line,
  }));
  const comparison = compare(proposalItems, fileItems);
  if (comparison.mismatches.length > 0) {
    problems.push(
      `${comparison.mismatches.length} payment(s) in the proposal are not in your file exactly as stated`,
    );
  }
  if (proposalItems.length === 0 && problems.length === 0) {
    problems.push('the proposal contains no payments');
  }

  const facts: [string, string][] = [
    ['Chain', input.cluster ? `Solana (genesis ${input.cluster})` : 'Solana'],
    ['Squads program', programId],
    ['Multisig', proposal.multisig],
    ['Vault (pays)', vault],
    ['Proposal', input.proposal],
    ['Transaction index', String(proposal.transactionIndex)],
    ['Proposed by', vt.creator],
  ];
  const since =
    proposal.statusTimestamp !== null ? ` (since ${iso(proposal.statusTimestamp)})` : '';
  facts.push(['Status', `${proposal.status}${since}`]);
  if (multisig) {
    facts.push(['Approvals', `${proposal.approved.length} of ${multisig.threshold} needed`]);
    if (proposal.rejected.length > 0) facts.push(['Rejections', String(proposal.rejected.length)]);
    if (proposal.cancelled.length > 0)
      facts.push(['Cancel votes', String(proposal.cancelled.length)]);
    facts.push(['Time lock', `${multisig.timeLockSeconds} seconds`]);
    if (proposal.status === 'Approved' && proposal.statusTimestamp !== null) {
      facts.push([
        'Executable from',
        iso(proposal.statusTimestamp + BigInt(multisig.timeLockSeconds)),
      ]);
    }
    if (proposal.transactionIndex <= multisig.staleTransactionIndex) {
      notes.push(
        proposal.status === 'Approved'
          ? 'this proposal is stale (a config change happened after it) but was already Approved, so it can still be executed'
          : 'this proposal is stale (a config change happened after it): it can no longer be approved or executed',
      );
    }
  } else {
    facts.push([
      'Approvals',
      `${proposal.approved.length} (multisig account could not be read, threshold unknown)`,
    ]);
  }

  return {
    verdict: problems.length === 0 ? 'MATCH' : 'MISMATCH',
    facts,
    problems,
    notes,
    comparison,
    proposalItems,
    fileItems,
  };
}
