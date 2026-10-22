import type { Chain } from './chain.js';

/**
 * ADR-0054: one multisig transaction the engine proposes for Approvers to
 * decide on, holding Calls from exactly one Dispatch. Chain-neutral — nothing
 * here knows about Squads or Safe beyond the discriminated `ChainProposalRef`.
 *
 * The phase is the engine's own bookkeeping of where a Proposal is,
 * deliberately separate from `ApprovalState`, which is what the Approvers
 * have done.
 * - `noted`: written down (ADR-0041), its propose transaction not yet known to have landed.
 * - `open`: proposed on-chain, Approvers are deciding.
 * - `executing`: the engine has written down and sent the execute transaction.
 * - `timed_out`: the deadline passed (ADR-0053); the Calls are ABANDONED and the engine keeps watching.
 * - `resolved`: every Call reached CONFIRMED or FAILED; nothing more to watch.
 */
export type ProposalPhase = 'noted' | 'open' | 'executing' | 'timed_out' | 'resolved';

/**
 * Whether a finished Proposal's accounts still need closing (Squads rent, #88): `pending` from the
 * moment it is known finished until a close succeeds (`closed`), so a restart does not forget it.
 * `null` is a Proposal nothing was ever asked to close (still live, or a chain that cannot close).
 */
export type CloseState = 'pending' | 'closed';

/** What the Approvers have done so far (docs/api.md's `approval.state`). `approved_after_deadline` is only ever seen on a `timed_out` Proposal (ADR-0053). */
export type ApprovalState = 'awaiting' | 'approved' | 'approved_after_deadline';

/** The chain's own handle for a Proposal — what an operator opens in the multisig's app. */
export type ChainProposalRef =
  | { kind: 'squads'; multisig: string; proposal: string; transactionIndex: number }
  | { kind: 'safe'; safe: string; safeTxHash: string; nonce: number };

/** An amount of one asset, as a non-negative integer string in the asset's smallest unit (as everywhere on the wire). */
export type AssetAmount = { asset: string; amount: string };

/**
 * What the Proposal should pay out, built from the same Dispatch's own items.
 * A mistake-catcher for an Approver comparing it with the caller's record, not
 * a control: the independent verifier (#89) is what checks the real bytes.
 */
export type ExpectedTotals = { recipients: number; totals: AssetAmount[] };

/** Funds a Proposal still holds back from the Funding Check, per holder (rent included). */
export type CommittedAmounts = { sender: AssetAmount[]; proposer: AssetAmount[] };

export type Proposal = {
  id: string;
  /** A Proposal never mixes Dispatches (ADR-0054). */
  dispatchId: string;
  chain: Chain;
  /** The multisig that is the Sender (the Squads vault or the Safe). */
  senderAddress: string;
  chainRef: ChainProposalRef;
  /** Opaque, Chain Handler-owned: enough to re-sign, re-post or execute. */
  payload: string;
  /** The proposal's own address (Squads PDA) or `safeTxHash`. Unique, so a re-post is idempotent. */
  proposalRef: string;
  /** Squads `transactionIndex`, Safe nonce. Unique per (chain, sender) on Solana only: a Safe nonce is reused after a timeout. */
  sequence: number | null;
  phase: ProposalPhase;
  approvalState: ApprovalState;
  approvals: number;
  threshold: number;
  /** When the engine stops waiting for approval and abandons the Calls (ADR-0053). */
  deadlineAt: Date;
  /** The multisig's time lock: no execution before this. */
  executeAfter: Date | null;
  timedOutAt: Date | null;
  resolvedAt: Date | null;
  closeState: CloseState | null;
  createdAt: Date;
  /** The watch loop picks Proposals whose `nextCheckAt` has passed. */
  nextCheckAt: Date;
  /** Consecutive failed reads, for backoff. */
  checkFailures: number;
  /** The signed propose transaction, kept so a crash after the write re-sends the same bytes. */
  proposeSignedBytes: string | null;
  proposeHash: string | null;
  expected: ExpectedTotals;
  committed: CommittedAmounts;
};
