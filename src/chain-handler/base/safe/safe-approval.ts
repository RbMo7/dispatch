import {
  decodeFunctionData,
  encodeFunctionData,
  encodePacked,
  concat,
  getAddress,
  isAddress,
  parseAbi,
  size,
  zeroAddress,
  type Address,
  type Hex,
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
import { NATIVE_ASSET_SYMBOL, type BaseTokenRegistry } from '../known-tokens.js';
import { MAX_SAFE_BUNDLE_LIMIT, type BaseSafeConfig } from './safe-config.js';
import { readSafeState, type SafeReadClient } from './safe-reads.js';
import {
  SafeTxServiceError,
  type ProposeTransactionBody,
  type SafeTxServiceClient,
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

export type SafeApprovalDeps = {
  config: BaseSafeConfig;
  chainId: number;
  /** Reads the Safe's `nonce()` and threshold, pinned to one block (safe-reads.ts). */
  client: SafeReadClient;
  signer: Pick<SignerClient, 'signSafeTransaction'>;
  service: Pick<SafeTxServiceClient, 'proposeTransaction'>;
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
  readonly proposerAddress: string;
  /** ADR-0051: one open proposal per Safe, because every proposal takes the Safe's next nonce. */
  readonly openProposalLimit = 1;
  /** A failed `execTransaction` leaves the Safe nonce unchanged, so retrying cannot help: the Calls fail on a `GS013` simulation (#84). */
  readonly reexecuteOnFailure = false;

  private readonly bundleLimit: number;

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

    const tx: SafeTransaction = {
      safe: config.safeAddress,
      chainId,
      to: multiSend,
      value: '0',
      data: encodeMultiSendCall(items),
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
      nonce: state.nonce.toString(),
    };
    const safeTxHash = safeTransactionHash(tx);
    const nonce = Number(state.nonce);
    if (!Number.isSafeInteger(nonce)) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `the Safe nonce ${state.nonce} is out of range`,
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
      // The payments leave the Safe. What the executor spends on gas is #85's.
      committed: { sender: totals, proposer: [] },
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

  readProposal(_ref: ChainProposalRef): Promise<Result<ProposalSnapshot, DispatchError>> {
    return Promise.resolve(notImplemented('reading a Safe proposal', '#84'));
  }

  prepareExecution(_proposal: Proposal): Promise<Result<PreparedTransaction, DispatchError>> {
    return Promise.resolve(notImplemented('executing a Safe proposal', '#84'));
  }

  estimateApprovalCost(
    _calls: CallForChain<'base'>[],
    _sender: string,
  ): Promise<Result<ApprovalCost, DispatchError>> {
    return Promise.resolve(notImplemented('estimating a Safe proposal cost', '#85'));
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

function notImplemented(what: string, ticket: string): Result<never, DispatchError> {
  return err({
    code: 'CHAIN_REJECTED',
    message: `${what} is not implemented (ticket ${ticket})`,
    chainDetail: { notImplemented: ticket },
  });
}
