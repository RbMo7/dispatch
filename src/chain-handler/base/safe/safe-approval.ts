import {
  concat,
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  getAddress,
  hashMessage,
  isAddress,
  pad,
  parseEventLogs,
  parseAbi,
  recoverAddress,
  size,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import type { CallForChain, EvmCall } from '../../../domain/call.js';
import type { DispatchError } from '../../../domain/errors.js';
import type { AssetAmount, ChainProposalRef, Proposal } from '../../../domain/proposal.js';
import { err, ok, type Result } from '../../../domain/result.js';
import { safeTransactionHash, type SafeTransaction } from '../../../signer/safe-transaction.js';
import type { SignerClient } from '../../../signer/client.js';
import type {
  ApprovalCapability,
  ApprovalCost,
  BuiltProposal,
  PreparedTransaction,
  ProposalSnapshot,
  SignedProposal,
} from '../../chain-handler.js';
import { validateEvmCall } from '../call-validation.js';
import { ERC20_ABI } from '../erc20.js';
import { isRpcOutage, mapBaseFailure } from '../error-mapping.js';
import { NATIVE_ASSET_SYMBOL, type BaseTokenRegistry } from '../known-tokens.js';
import { decodeUnsignedTransaction, encodeUnsignedTransaction } from '../transaction-codec.js';
import {
  dummySignatures,
  encodeExecTransaction,
  EXEC_TRANSACTION_ABI,
  estimateExecutionCost,
  withGasMargin,
} from './execution-cost.js';
import { MAX_SAFE_BUNDLE_LIMIT, type BaseSafeConfig } from './safe-config.js';
import {
  readSafeSigners,
  readSafeState,
  type SafeReadClient,
  type SafeSignerState,
} from './safe-reads.js';
import {
  SafeTxServiceError,
  type ProposeTransactionBody,
  type SafeTxServiceClient,
  type ServiceMultisigTransaction,
} from './tx-service-client.js';

/**
 * MultiSendCallOnly by the Safe's `VERSION()` (spike #79): 1.4.1, and 1.3.0's
 * eip155 variant (the one safe-deployments maps Base to). The Signer's
 * `allowedSafe` policy allowlists exactly these, plus 1.3.0's canonical one.
 */
export const MULTI_SEND_CALL_ONLY: Readonly<Record<string, Address>> = {
  '1.4.1': '0x9641d764fc13c8B624c04430C7356C1C7C8102e2',
  '1.3.0': '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B',
};

/** What owners see as the proposal's origin in the Safe app. */
export const SAFE_PROPOSAL_ORIGIN = 'Dispatch engine';

const MULTI_SEND_ABI = parseAbi(['function multiSend(bytes transactions)']);
/** Safe 1.3.0 and 1.4.1 emit this when `execTransaction` ran the inner transaction successfully (#88). */
/**
 * `ExecutionSuccess(bytes32,uint256)` has one topic 0 in every Safe version, but where the hash is carried
 * differs: Safe 1.4.1 declares `txHash` indexed (a topic, 32 bytes of data), Safe 1.3.0 does not (64 bytes of
 * data). A non-strict decode with the wrong layout returns no args, so both are tried (found live, #87).
 */
const EXECUTION_SUCCESS_ABIS = [
  parseAbi(['event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)']),
  parseAbi(['event ExecutionSuccess(bytes32 txHash, uint256 payment)']),
] as const;
const THRESHOLD_ABI = parseAbi(['function getThreshold() view returns (uint256)']);

/** One payment inside a bundle, classified from its Call. */
type BundleItem = {
  to: Address;
  value: bigint;
  data: Hex;
  asset: string;
  recipient: Address;
  amount: bigint;
};

/** What `buildProposal` keeps in `BuiltProposal.payload`: the whole Safe transaction, enough to re-sign and re-post. */
type SafeProposalPayload = SafeTransaction & { safeTxHash: Hex };

/** What the Safe half needs of the node: `SafeReadClient`, plus `eth_call`, gas estimation and the fee reads. */
export type SafeApprovalClient = SafeReadClient &
  Pick<PublicClient, 'call' | 'estimateGas' | 'getBlock' | 'getTransactionReceipt'>;

export type SafeApprovalDeps = {
  config: BaseSafeConfig;
  chainId: number;
  /** Reads the Safe's state pinned to one block (safe-reads.ts), simulates and prices the execute. */
  client: SafeApprovalClient;
  signer: Pick<SignerClient, 'signSafeTransaction'>;
  service: Pick<
    SafeTxServiceClient,
    'proposeTransaction' | 'getMultisigTransaction' | 'listTransactionsAtNonce'
  >;
  /**
   * The Base handler's own `prepare` (ADR-0039, ADR-0037): the execute goes
   * through it as one ordinary call to the Safe, so nonce authority and fee
   * estimation stay in one place.
   */
  prepare: (
    items: EvmCall[],
    sender: string,
  ) => Promise<Result<PreparedTransaction[], DispatchError>>;
  /** How long to wait before re-reading a stale block, ms. Default 250; tests use 0. */
  staleReadRetryDelayMs?: number;
  /** The same registry the Base handler resolves a Payment's asset against; an ERC-20 item must go to one of these. */
  knownTokens: BaseTokenRegistry;
};

/**
 * ADR-0051/0054: the Safe implementation of `ApprovalCapability`, propose
 * half (#83). A Dispatch's Calls become MultiSendCallOnly Safe transactions
 * at the Safe's next nonce, signed as the delegate (ADR-0052) and posted to
 * the Safe Transaction Service. The executor key proposes and, later,
 * executes; it is never an owner and the Safe never signs here (ADR-0049).
 * Reading, executing and the cost estimate belong to #84 and #85.
 */
export class SafeApproval implements ApprovalCapability<'base'> {
  /** The Funding Check names these in `INSUFFICIENT_FUNDS`'s `chainDetail.holder`. */
  readonly holders = { sender: 'safe', proposer: 'executor' } as const;
  readonly proposerAddress: string;
  /** ADR-0051: one open proposal per Safe, because every proposal takes the Safe's next nonce. */
  readonly openProposalLimit = 1;
  /** Spike #79: 60 s while awaiting approval is about 43,000 service requests a month, inside a keyed quota; 15 s would not be. */
  readonly watchIntervalMs = 60_000;

  private readonly bundleLimit: number;
  /** The highest block any signer read came from: a later read from an older block is a stale node. */
  private highestBlockRead = 0n;

  constructor(private readonly deps: SafeApprovalDeps) {
    this.proposerAddress = deps.config.executorAddress;
    if (
      !Number.isSafeInteger(deps.config.bundleLimit) ||
      deps.config.bundleLimit < 1 ||
      deps.config.bundleLimit > MAX_SAFE_BUNDLE_LIMIT
    ) {
      throw new Error(`Safe bundle limit must be 1..${MAX_SAFE_BUNDLE_LIMIT}`);
    }
    this.bundleLimit = deps.config.bundleLimit;
  }

  planBundles(calls: CallForChain<'base'>[]): Result<number[][], DispatchError> {
    for (const call of calls) {
      const item = this.classify(call);
      if (!item.ok) return item;
    }
    const bundles: number[][] = [];
    for (let start = 0; start < calls.length; start += this.bundleLimit) {
      const end = Math.min(start + this.bundleLimit, calls.length);
      bundles.push(Array.from({ length: end - start }, (_, i) => start + i));
    }
    return ok(bundles);
  }

  async buildProposal(input: {
    calls: CallForChain<'base'>[];
    sender: string;
    minSequence?: number;
  }): Promise<Result<BuiltProposal, DispatchError>> {
    const { config, chainId } = this.deps;
    if (input.sender.toLowerCase() !== config.safeAddress.toLowerCase()) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `asked to propose for ${input.sender}, but this engine's Safe is ${config.safeAddress}`,
      });
    }
    if (input.calls.length === 0 || input.calls.length > this.bundleLimit) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `a Safe proposal holds 1 to ${this.bundleLimit} Calls, got ${input.calls.length}`,
      });
    }

    const items: BundleItem[] = [];
    for (const call of input.calls) {
      const item = this.classify(call);
      if (!item.ok) return item;
      items.push(item.value);
    }

    let state;
    try {
      state = await readSafeState(this.deps.client, config.safeAddress);
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `could not read the Safe ${config.safeAddress}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    if (state.chainId !== chainId) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `the RPC answered chain ID ${state.chainId}, expected ${chainId}`,
      });
    }
    if (!state.hasCode) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `${config.safeAddress} has no contract on chain ${chainId}: not a Safe`,
      });
    }
    const multiSend = MULTI_SEND_CALL_ONLY[state.version];
    if (multiSend === undefined) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `the Safe reports VERSION() "${state.version}"; only ${Object.keys(MULTI_SEND_CALL_ONLY).join(' and ')} are supported`,
      });
    }

    // #84: a read right after the engine's own execution can still say the old nonce (spike #79,
    // finding 5). The engine knows which sequences it has seen consumed; never build below that.
    const chainNonce = state.nonce;
    const nonceBig =
      input.minSequence !== undefined && BigInt(input.minSequence) > chainNonce
        ? BigInt(input.minSequence)
        : chainNonce;
    const nonce = Number(nonceBig);
    if (!Number.isSafeInteger(nonce)) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `the Safe nonce ${nonceBig} is out of range`,
      });
    }

    const data = encodeMultiSendCall(items);
    const tx: SafeTransaction = {
      safe: config.safeAddress,
      chainId,
      to: multiSend,
      value: '0',
      data,
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: nonceBig.toString(),
    };
    const safeTxHash = safeTransactionHash(tx);

    // What the executor will have to pay for this proposal's execute stays committed until it is closed (#85).
    let gasCost: bigint;
    try {
      gasCost = await this.executionCost(tx, items.length, state.threshold);
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `could not price the Safe execute: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }

    const chainRef: ChainProposalRef = {
      kind: 'safe',
      safe: config.safeAddress,
      safeTxHash,
      nonce,
    };
    const payload: SafeProposalPayload = { ...tx, safeTxHash };
    const totals = sumByAsset(items);
    return ok({
      chainRef,
      proposalRef: safeTxHash,
      payload: JSON.stringify(payload),
      sequence: nonce,
      threshold: state.threshold,
      executeAfter: null,
      expected: {
        recipients: new Set(items.map((item) => item.recipient.toLowerCase())).size,
        totals,
      },
      // The payments leave the Safe; the execute's gas leaves the executor (#85).
      committed: {
        sender: totals,
        proposer: [{ asset: NATIVE_ASSET_SYMBOL, amount: gasCost.toString() }],
      },
    });
  }

  async signProposal(built: BuiltProposal): Promise<Result<SignedProposal, DispatchError>> {
    const payload = parsePayload(built.payload);
    if (!payload.ok) return payload;
    const { safeTxHash, ...tx } = payload.value;

    // The engine's own hash, never one carried in the payload: a payload that
    // does not hash to its own safeTxHash is a bug or tampering, not signable.
    if (safeTransactionHash(tx) !== safeTxHash || built.proposalRef !== safeTxHash) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'the Safe proposal does not hash to its own safeTxHash',
      });
    }

    const signature = await this.deps.signer.signSafeTransaction({
      chain: 'base',
      address: this.deps.config.executorAddress,
      safeTransaction: tx,
    });
    if (!signature.ok) return signature;

    const body: ProposeTransactionBody = {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: Number(tx.nonce),
      sender: this.deps.config.executorAddress,
      signature: signature.value,
      contractTransactionHash: safeTxHash,
      origin: SAFE_PROPOSAL_ORIGIN,
    };
    return ok({ signedBytes: JSON.stringify(body), hash: safeTxHash });
  }

  async submitProposal(signed: SignedProposal): Promise<Result<void, DispatchError>> {
    let body: ProposeTransactionBody;
    try {
      body = JSON.parse(signed.signedBytes) as ProposeTransactionBody;
    } catch {
      return err({ code: 'CHAIN_REJECTED', message: 'the signed Safe proposal is not valid JSON' });
    }
    if (body.contractTransactionHash !== signed.hash) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'the signed Safe proposal does not match its hash',
      });
    }
    try {
      await this.deps.service.proposeTransaction(this.deps.config.safeAddress, body);
      return ok(undefined);
    } catch (cause) {
      return err(mapServiceError(cause));
    }
  }

  async readProposal(ref: ChainProposalRef): Promise<Result<ProposalSnapshot, DispatchError>> {
    if (ref.kind !== 'safe') {
      return err({ code: 'CHAIN_REJECTED', message: 'not a Safe proposal reference' });
    }
    const view = await this.viewProposal(ref.safe, ref.safeTxHash);
    if (!view.ok) return view;
    const { state, service, signers } = view.value;
    const base = { approvals: signers.size, threshold: state.threshold };
    const proposalNonce = BigInt(ref.nonce);

    // (1) Executed: the service says so, and the chain agrees (#88): its transaction is the proof of payment.
    if (service?.isExecuted) {
      const proven = await this.verifyExecution(ref, service.transactionHash);
      if (!proven.ok) return proven;
      return ok({
        ...base,
        status: 'executed',
        executedHash: proven.value,
        executable: false,
      });
    }

    // (2) The nonce moved past this proposal. The engine's own execution moves it too, so that alone
    // proves nothing: only the transaction executed AT this nonce says which of the two happened.
    if (state.nonce > proposalNonce) {
      let entries;
      try {
        entries = await this.deps.service.listTransactionsAtNonce(
          this.deps.config.safeAddress,
          ref.nonce,
        );
      } catch (cause) {
        return err(mapServiceError(cause));
      }
      const winner = entries.find((entry) => entry.isExecuted);
      if (winner) {
        if (winner.safeTxHash.toLowerCase() === ref.safeTxHash.toLowerCase()) {
          const proven = await this.verifyExecution(ref, winner.transactionHash);
          if (!proven.ok) return proven;
          return ok({ ...base, status: 'executed', executedHash: proven.value, executable: false });
        }
        // A different transaction took this nonce: a rejection or a replacement (spike #79, section 6).
        return ok({ ...base, status: 'rejected', executable: false });
      }
      // The nonce moved but the service has not indexed what executed yet: not provably rejected, so
      // keep watching. Never `approved`: this proposal can no longer execute at this nonce.
      return ok({ ...base, status: 'active', executable: false });
    }

    // (3) Still at its nonce: approved once enough current owners confirmed.
    const approved = signers.size >= state.threshold && state.nonce === proposalNonce;
    return ok({ ...base, status: approved ? 'approved' : 'active', executable: approved });
  }

  /**
   * #88: the service is a convenience, not proof of payment. Before a proposal
   * is called executed (and its Calls CONFIRMED, possibly by someone else), the
   * executing transaction's own receipt must have succeeded and carry this
   * Safe's `ExecutionSuccess` event for this `safeTxHash`. Anything else,
   * including a receipt that cannot be read yet, leaves the proposal unsettled.
   */
  private async verifyExecution(
    ref: Extract<ChainProposalRef, { kind: 'safe' }>,
    transactionHash: string | null | undefined,
  ): Promise<Result<string, DispatchError>> {
    const unverified = (message: string): Result<string, DispatchError> =>
      err({
        code: 'RPC_UNAVAILABLE',
        message,
        chainDetail: { reason: 'EXECUTION_NOT_VERIFIED', safeTxHash: ref.safeTxHash },
      });
    if (!transactionHash) {
      return unverified(
        'the Safe Transaction Service reports an execution without its transaction hash',
      );
    }
    let receipt;
    try {
      receipt = await this.deps.client.getTransactionReceipt({ hash: transactionHash as Hex });
    } catch (cause) {
      return unverified(
        `could not read the receipt of ${transactionHash}: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    if (receipt.status !== 'success') {
      return unverified(`the transaction ${transactionHash} did not succeed on-chain`);
    }
    const events = EXECUTION_SUCCESS_ABIS.flatMap((abi) =>
      parseEventLogs({ abi, eventName: 'ExecutionSuccess', logs: receipt.logs, strict: false }),
    );
    const matched = events.some((event) => {
      // `args` is undefined when the log is in the other version's layout.
      const txHash = (event.args as { txHash?: unknown } | undefined)?.txHash;
      return (
        event.address.toLowerCase() === ref.safe.toLowerCase() &&
        typeof txHash === 'string' &&
        txHash.toLowerCase() === ref.safeTxHash.toLowerCase()
      );
    });
    if (!matched) {
      return unverified(
        `the receipt of ${transactionHash} has no ExecutionSuccess event of ${ref.safe} for ${ref.safeTxHash}`,
      );
    }
    return ok(transactionHash);
  }

  async prepareExecution(proposal: Proposal): Promise<Result<PreparedTransaction, DispatchError>> {
    const { config, chainId } = this.deps;
    const ref = proposal.chainRef;
    if (ref.kind !== 'safe') {
      return err({ code: 'CHAIN_REJECTED', message: 'not a Safe proposal' });
    }
    const parsed = parsePayload(proposal.payload);
    if (!parsed.ok) return parsed;
    const { safeTxHash, ...tx } = parsed.value;
    // The engine's own hash, never one carried in the payload (as in signProposal).
    if (
      safeTransactionHash(tx) !== safeTxHash ||
      safeTxHash.toLowerCase() !== ref.safeTxHash.toLowerCase() ||
      ref.safe.toLowerCase() !== config.safeAddress.toLowerCase() ||
      tx.safe.toLowerCase() !== config.safeAddress.toLowerCase() ||
      tx.chainId !== chainId
    ) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'the Safe proposal payload does not match its own hash, Safe or chain',
      });
    }

    const view = await this.viewProposal(tx.safe, safeTxHash);
    if (!view.ok) return view;
    const { state, signers } = view.value;
    const nonce = BigInt(tx.nonce);
    if (state.nonce > nonce) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `the Safe nonce is ${state.nonce}, past this proposal's ${nonce}: it can never execute`,
      });
    }
    if (state.nonce < nonce || signers.size < state.threshold) {
      // A stale or lagging read, or a confirmation not visible yet: not a verdict on the proposal.
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `cannot assemble ${state.threshold} valid signatures yet (${signers.size} readable, Safe nonce ${state.nonce}, proposal nonce ${nonce})`,
      });
    }

    // Ascending owner address, as many as the threshold needs (spike #79, section 5).
    const chosen = [...signers.values()]
      .sort((a, b) => (a.owner.toLowerCase() < b.owner.toLowerCase() ? -1 : 1))
      .slice(0, state.threshold);
    const calldata = encodeExecTransaction(tx, concat(chosen.map((entry) => entry.signature)));

    const request = { account: config.executorAddress, to: tx.safe, data: calldata } as const;
    // Always simulated first: a revert (GS013 and any other) means the proposal can never succeed as built.
    try {
      const simulated = await this.deps.client.call(request);
      if (simulated.data !== undefined) {
        const success = decodeFunctionResult({
          abi: EXEC_TRANSACTION_ABI,
          functionName: 'execTransaction',
          data: simulated.data,
        });
        if (!success) throw new Error('execTransaction returned false');
      }
    } catch (cause) {
      return err(simulationFailure(cause));
    }
    let estimate: bigint;
    try {
      estimate = await this.deps.client.estimateGas(request);
    } catch (cause) {
      return err(simulationFailure(cause));
    }

    // Through the Base handler's own prepare: nonce authority (ADR-0039) and fees (ADR-0037) stay there.
    const prepared = await this.deps.prepare(
      [{ to: tx.safe, value: '0', data: calldata }],
      config.executorAddress,
    );
    if (!prepared.ok) return prepared;
    const first = prepared.value[0];
    if (!first || prepared.value.length !== 1) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'the Base handler did not prepare exactly one transaction',
      });
    }
    // The estimate ran 2 to 3 percent under real usage (spike #79) and a short gas limit reverts the
    // whole execute: use our own estimate with a margin, never less than what prepare chose.
    const encoded = decodeUnsignedTransaction(first.unsignedTransaction);
    const margin = withGasMargin(estimate);
    if (margin > BigInt(encoded.gas)) encoded.gas = margin.toString();
    return ok({
      callIndex: first.callIndex,
      unsignedTransaction: encodeUnsignedTransaction(encoded),
    });
  }

  async estimateApprovalCost(
    calls: CallForChain<'base'>[],
    sender: string,
  ): Promise<Result<ApprovalCost, DispatchError>> {
    const { config, chainId } = this.deps;
    if (sender.toLowerCase() !== config.safeAddress.toLowerCase()) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `asked to price for ${sender}, but this engine's Safe is ${config.safeAddress}`,
      });
    }
    const items: BundleItem[] = [];
    for (const call of calls) {
      const item = this.classify(call);
      if (!item.ok) return item;
      items.push(item.value);
    }
    if (items.length === 0) {
      return ok({ asset: NATIVE_ASSET_SYMBOL, amount: '0', rentLocked: '0' });
    }

    try {
      const threshold = Number(
        await this.deps.client.readContract({
          address: config.safeAddress,
          abi: THRESHOLD_ABI,
          functionName: 'getThreshold',
        }),
      );
      // One proposal per bundleLimit items; the calldata (and so the L1 data fee) is sized with
      // threshold-many dummy signatures. The version only changes which MultiSend address is used.
      let total = 0n;
      for (let start = 0; start < items.length; start += this.bundleLimit) {
        const chunk = items.slice(start, start + this.bundleLimit);
        const tx = {
          to: MULTI_SEND_CALL_ONLY['1.4.1'] as Address,
          value: '0',
          data: encodeMultiSendCall(chunk),
          operation: 1 as const,
          safeTxGas: '0',
          baseGas: '0',
          gasPrice: '0',
          gasToken: zeroAddress,
          refundReceiver: zeroAddress,
        };
        total += await estimateExecutionCost(this.deps.client, {
          safe: config.safeAddress,
          chainId,
          calldata: encodeExecTransaction(tx, dummySignatures(threshold)),
          items: chunk.length,
          signatures: threshold,
        });
      }
      return ok({ asset: NATIVE_ASSET_SYMBOL, amount: total.toString(), rentLocked: '0' });
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `could not price the Safe execute: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  }

  /** The executor's cost of one proposal's `execTransaction` (#85), priced like `estimateApprovalCost`. */
  private executionCost(tx: SafeTransaction, items: number, threshold: number): Promise<bigint> {
    return estimateExecutionCost(this.deps.client, {
      safe: this.deps.config.safeAddress,
      chainId: this.deps.chainId,
      calldata: encodeExecTransaction(tx, dummySignatures(threshold)),
      items,
      signatures: threshold,
    });
  }

  /**
   * Everything one read of a proposal needs: the Safe's owners, threshold and
   * nonce from the chain (the authority, ADR-0051), the service's view of the
   * transaction, and the valid confirmations: DISTINCT current owners with an
   * ECDSA signature that recovers to them over the `safeTxHash`, or an
   * on-chain `approveHash`. The engine's own key never counts (ADR-0049).
   */
  private async viewProposal(
    safe: string,
    safeTxHash: string,
  ): Promise<
    Result<
      {
        state: SafeSignerState;
        service: ServiceMultisigTransaction | null;
        signers: Map<string, { owner: Address; signature: Hex }>;
      },
      DispatchError
    >
  > {
    const { config } = this.deps;
    if (safe.toLowerCase() !== config.safeAddress.toLowerCase()) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `the proposal is for ${safe}, but this engine's Safe is ${config.safeAddress}`,
      });
    }
    let state: SafeSignerState;
    try {
      state = await readSafeSigners(this.deps.client, config.safeAddress, safeTxHash as Hex, {
        minBlock: this.highestBlockRead,
        retryDelayMs: this.deps.staleReadRetryDelayMs ?? 250,
      });
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `could not read the Safe ${config.safeAddress}: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
    if (state.blockNumber > this.highestBlockRead) this.highestBlockRead = state.blockNumber;

    let service: ServiceMultisigTransaction | null;
    try {
      service = await this.deps.service.getMultisigTransaction(safeTxHash);
    } catch (cause) {
      return err(mapServiceError(cause));
    }
    if (service !== null && service.safeTxHash.toLowerCase() !== safeTxHash.toLowerCase()) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: 'the Safe Transaction Service answered for a different transaction',
      });
    }

    const owners = new Map(state.owners.map((owner) => [owner.toLowerCase(), owner]));
    owners.delete(config.executorAddress.toLowerCase());
    const signers = new Map<string, { owner: Address; signature: Hex }>();
    for (const confirmation of service?.confirmations ?? []) {
      const key = confirmation.owner.toLowerCase();
      const owner = owners.get(key);
      if (owner === undefined || signers.has(key)) continue;
      if (confirmation.signatureType === 'APPROVED_HASH') continue; // counted from the chain below
      if (await signatureIsFrom(owner, safeTxHash as Hex, confirmation.signature)) {
        signers.set(key, { owner, signature: confirmation.signature as Hex });
      }
    }
    for (const [key, owner] of owners) {
      if (signers.has(key) || state.approved.get(key) !== true) continue;
      // r = the owner padded to 32 bytes, s = 0, v = 1: the Safe checks `approvedHashes` itself.
      signers.set(key, {
        owner,
        signature: concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01']),
      });
    }
    return ok({ state, service, signers });
  }

  /**
   * A Call that can go inside a MultiSendCallOnly bundle: a native transfer,
   * or an ERC-20 `transfer` of a known token. Everything else is refused,
   * like the Base handler refuses what it cannot encode: a raw contract call
   * has no asset the `expected` totals or the Funding Check could count.
   */
  private classify(call: EvmCall): Result<BundleItem, DispatchError> {
    const valid = validateEvmCall(call);
    if (!valid.ok) return valid;
    const to = getAddress(call.to);
    const value = BigInt(call.value);
    const data = call.data.toLowerCase() as Hex;

    if (data === '0x') {
      return ok({ to, value, data, asset: NATIVE_ASSET_SYMBOL, recipient: to, amount: value });
    }

    const token = Object.entries(this.deps.knownTokens).find(
      ([, known]) => isAddress(known.contractAddress) && getAddress(known.contractAddress) === to,
    );
    const refuse = (why: string): Result<BundleItem, DispatchError> =>
      err({
        code: 'CHAIN_REJECTED',
        message: `a Safe proposal can only hold native transfers and known-token ERC-20 transfers: ${why}`,
        chainDetail: { to: call.to },
      });
    if (token === undefined) return refuse(`${call.to} is not a configured token`);
    if (value !== 0n) return refuse('a token transfer must carry no ETH value');

    let recipient: Address;
    let amount: bigint;
    try {
      const decoded = decodeFunctionData({ abi: ERC20_ABI, data });
      if (decoded.functionName !== 'transfer') return refuse('the call is not an ERC-20 transfer');
      [recipient, amount] = decoded.args;
      // Whole-call check: decoding ignores trailing bytes, the encoding must not have any.
      if (
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'transfer',
          args: [recipient, amount],
        }) !== data
      ) {
        return refuse('the transfer data is not canonical');
      }
    } catch {
      return refuse('the call is not an ERC-20 transfer');
    }
    return ok({ to, value: 0n, data, asset: token[0], recipient, amount });
  }
}

/** `multiSend(bytes)` calldata: each item `operation(uint8) | to(address) | value(uint256) | dataLength(uint256) | data`. */
export function encodeMultiSendCall(
  items: readonly { to: Address; value: bigint; data: Hex }[],
): Hex {
  const transactions = concat(
    items.map((item) =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, item.to, item.value, BigInt(size(item.data)), item.data],
      ),
    ),
  );
  return encodeFunctionData({
    abi: MULTI_SEND_ABI,
    functionName: 'multiSend',
    args: [transactions],
  });
}

/** Per-asset totals, in the order each asset first appears. */
function sumByAsset(items: readonly BundleItem[]): AssetAmount[] {
  const totals = new Map<string, bigint>();
  for (const item of items) totals.set(item.asset, (totals.get(item.asset) ?? 0n) + item.amount);
  return [...totals].map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}

function parsePayload(raw: string): Result<SafeProposalPayload, DispatchError> {
  const bad = (why: string): Result<SafeProposalPayload, DispatchError> =>
    err({ code: 'CHAIN_REJECTED', message: `the Safe proposal payload is unusable: ${why}` });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return bad('not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) return bad('not an object');
  const p = parsed as Record<string, unknown>;
  const text = [
    'safe',
    'to',
    'value',
    'data',
    'safeTxGas',
    'baseGas',
    'gasPrice',
    'gasToken',
    'refundReceiver',
    'nonce',
    'safeTxHash',
  ];
  for (const key of text) if (typeof p[key] !== 'string') return bad(`${key} is not a string`);
  if (typeof p.chainId !== 'number') return bad('chainId is not a number');
  if (p.operation !== 0 && p.operation !== 1) return bad('operation is not 0 or 1');
  return ok(p as unknown as SafeProposalPayload);
}

/**
 * Safe Transaction Service failures as the repo's errors. A 401 or 422 is a
 * definite refusal that waiting cannot fix (a missing or wrong key; the
 * executor is not a registered delegate, or the hash/signature is wrong), so
 * it says so loudly; the rest are the service being busy or away.
 */
function mapServiceError(cause: unknown): DispatchError {
  if (!(cause instanceof SafeTxServiceError)) {
    return {
      code: 'RPC_UNAVAILABLE',
      message: `Safe Transaction Service call failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
  }
  const chainDetail = { kind: cause.kind, status: cause.status };
  switch (cause.kind) {
    case 'unauthorized':
      return {
        code: 'CHAIN_REJECTED',
        message: `the Safe Transaction Service refused the engine's API key: ${cause.message}`,
        chainDetail,
      };
    case 'rejected':
      return {
        code: 'CHAIN_REJECTED',
        message:
          cause.status === 422
            ? `the Safe Transaction Service refused the proposal (422): the executor is probably not a registered delegate of the Safe, or the signature does not match. ${cause.message}`
            : `the Safe Transaction Service refused the proposal: ${cause.message}`,
        chainDetail,
      };
    case 'not-found':
      return { code: 'CHAIN_REJECTED', message: cause.message, chainDetail };
    default:
      // unreachable, rate-limited, server-error, invalid-response: try again later.
      return { code: 'RPC_UNAVAILABLE', message: cause.message, chainDetail };
  }
}

/**
 * Whether `signature` is `owner`'s signature over `safeTxHash`: the raw-digest
 * kind (v 27 or 28) or the `eth_sign` kind (v 31 or 32, which the Safe unwraps
 * itself). Anything else (a contract signature, garbage) is not counted.
 */
async function signatureIsFrom(
  owner: Address,
  safeTxHash: Hex,
  signature: string,
): Promise<boolean> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  const v = Number.parseInt(signature.slice(-2), 16);
  try {
    let recovered: Address;
    if (v === 27 || v === 28) {
      recovered = await recoverAddress({ hash: safeTxHash, signature: signature as Hex });
    } else if (v === 31 || v === 32) {
      const plain = `${signature.slice(0, -2)}${(v - 4).toString(16)}` as Hex;
      recovered = await recoverAddress({
        hash: hashMessage({ raw: safeTxHash }),
        signature: plain,
      });
    } else {
      return false;
    }
    return recovered.toLowerCase() === owner.toLowerCase();
  } catch {
    return false;
  }
}

/** A simulation that did not pass: an outage is retried, anything else (GS013, GS026, a revert) means the proposal cannot succeed as built. */
function simulationFailure(cause: unknown): DispatchError {
  const mapped = mapBaseFailure(cause);
  if (mapped.code === 'RPC_UNAVAILABLE' || isRpcOutage(cause)) {
    return { ...mapped, code: 'RPC_UNAVAILABLE' };
  }
  return {
    code: 'CHAIN_REJECTED',
    message: `simulating the Safe execTransaction failed, so it can never succeed as built: ${mapped.message}`,
    ...(mapped.chainDetail === undefined ? {} : { chainDetail: mapped.chainDetail }),
  };
}
