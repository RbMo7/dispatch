import type { CallForChain } from '../../domain/call.js';
import type { Chain } from '../../domain/chain.js';
import type { DispatchError } from '../../domain/errors.js';
import type { ChainProposalRef, Proposal } from '../../domain/proposal.js';
import { ok, type Result } from '../../domain/result.js';
import type {
  ApprovalCapability,
  ApprovalCost,
  BuiltProposal,
  PreparedTransaction,
  ProposalSnapshot,
  SignedProposal,
} from '../chain-handler.js';

/**
 * A scriptable `ApprovalCapability` (ADR-0054) for offline tests: every method
 * succeeds with a plausible default, records what it was asked, and can be
 * replaced per test (`fake.signImpl = () => Promise.resolve(err(...))`). It
 * never touches a chain, a Signer or a clock.
 */
export class FakeApproval<C extends Chain = Chain> implements ApprovalCapability<C> {
  holders: ApprovalCapability<C>['holders'] = { sender: 'vault', proposer: 'memberKey' };
  proposerAddress = 'proposer-key';
  openProposalLimit = Number.POSITIVE_INFINITY;
  reexecuteOnFailure = true;

  /** Largest bundle `planBundles` makes by default; Infinity puts a Dispatch in one Proposal. */
  bundleSize = Number.POSITIVE_INFINITY;
  /** The threshold every built Proposal reports. */
  threshold = 2;
  private nextSequence = 1;

  readonly planned: CallForChain<C>[][] = [];
  readonly built: { calls: CallForChain<C>[]; sender: string; proposal: BuiltProposal }[] = [];
  readonly signed: BuiltProposal[] = [];
  readonly submitted: SignedProposal[] = [];
  /** The order the steps ran in, e.g. `build:prop-1`, `sign:prop-1`, `submit:hash-prop-1`. */
  readonly events: string[] = [];

  planBundlesImpl: (calls: CallForChain<C>[]) => Result<number[][], DispatchError> = (calls) => {
    const bundles: number[][] = [];
    for (let i = 0; i < calls.length; i += this.bundleSize) {
      bundles.push(calls.slice(i, i + this.bundleSize).map((_, j) => i + j));
    }
    return ok(bundles);
  };

  buildImpl: (input: {
    calls: CallForChain<C>[];
    sender: string;
  }) => Promise<Result<BuiltProposal, DispatchError>> = (input) => {
    const sequence = this.nextSequence++;
    const proposalRef = `prop-${sequence}`;
    const chainRef: ChainProposalRef = {
      kind: 'squads',
      multisig: input.sender,
      proposal: proposalRef,
      transactionIndex: sequence,
    };
    return Promise.resolve(
      ok({
        chainRef,
        proposalRef,
        payload: `payload-${proposalRef}`,
        sequence,
        threshold: this.threshold,
        executeAfter: null,
        expected: { recipients: input.calls.length, totals: [] },
        committed: { sender: [], proposer: [] },
      }),
    );
  };

  signImpl: (built: BuiltProposal) => Promise<Result<SignedProposal, DispatchError>> = (built) =>
    Promise.resolve(
      ok({ signedBytes: `signed-${built.proposalRef}`, hash: `hash-${built.proposalRef}` }),
    );

  submitImpl: (signed: SignedProposal) => Promise<Result<void, DispatchError>> = () =>
    Promise.resolve(ok(undefined));

  readImpl: (ref: ChainProposalRef) => Promise<Result<ProposalSnapshot, DispatchError>> = () =>
    Promise.resolve(
      ok({ status: 'active', approvals: 0, threshold: this.threshold, executable: false }),
    );

  prepareExecutionImpl: (
    proposal: Proposal,
  ) => Promise<Result<PreparedTransaction, DispatchError>> = (proposal) =>
    Promise.resolve(ok({ callIndex: 0, unsignedTransaction: `execute-${proposal.proposalRef}` }));

  estimateImpl: (calls: CallForChain<C>[]) => Promise<Result<ApprovalCost, DispatchError>> = () =>
    Promise.resolve(ok({ asset: 'SOL', amount: '0', rentLocked: '0' }));

  closeImpl: (proposal: Proposal) => Promise<Result<void, DispatchError>> = () =>
    Promise.resolve(ok(undefined));

  planBundles(calls: CallForChain<C>[]): Result<number[][], DispatchError> {
    this.planned.push(calls);
    return this.planBundlesImpl(calls);
  }

  async buildProposal(input: {
    calls: CallForChain<C>[];
    sender: string;
  }): Promise<Result<BuiltProposal, DispatchError>> {
    const result = await this.buildImpl(input);
    if (result.ok) {
      this.built.push({ ...input, proposal: result.value });
      this.events.push(`build:${result.value.proposalRef}`);
    }
    return result;
  }

  async signProposal(built: BuiltProposal): Promise<Result<SignedProposal, DispatchError>> {
    const result = await this.signImpl(built);
    this.events.push(`${result.ok ? 'sign' : 'sign-failed'}:${built.proposalRef}`);
    if (result.ok) this.signed.push(built);
    return result;
  }

  async submitProposal(signed: SignedProposal): Promise<Result<void, DispatchError>> {
    const result = await this.submitImpl(signed);
    this.events.push(`${result.ok ? 'submit' : 'submit-failed'}:${signed.hash}`);
    if (result.ok) this.submitted.push(signed);
    return result;
  }

  readProposal(ref: ChainProposalRef): Promise<Result<ProposalSnapshot, DispatchError>> {
    return this.readImpl(ref);
  }

  prepareExecution(proposal: Proposal): Promise<Result<PreparedTransaction, DispatchError>> {
    return this.prepareExecutionImpl(proposal);
  }

  estimateApprovalCost(calls: CallForChain<C>[]): Promise<Result<ApprovalCost, DispatchError>> {
    return this.estimateImpl(calls);
  }

  closeProposal(proposal: Proposal): Promise<Result<void, DispatchError>> {
    return this.closeImpl(proposal);
  }
}
