import { randomUUID } from 'node:crypto';

import {
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  createPublicClient,
  decodeFunctionData,
  getAddress,
  http,
  isAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  serializeTransaction,
  type Address,
  type PublicClient,
  type TransactionSerializableEIP1559,
  type TransactionSerializedEIP1559,
} from 'viem';
import type { Logger } from 'pino';

import type { CallForChain, DispatchItem, EvmCall, Payment } from '../../domain/call.js';
import type { BulkCall } from '../../domain/dispatch.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
import { logger as defaultLogger } from '../../logger.js';
import type { NonceHistoryStore } from '../../repository/nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import type {
  Balance,
  BroadcastResult,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  PrepareOptions,
  SignedTransaction,
  BulkCallPlan,
  BulkCallRequest,
  BundleSlotStatus,
} from '../chain-handler.js';
import {
  AGGREGATE3_VALUE_ABI,
  CANONICAL_MULTICALL3,
  chunk,
  encodeAggregate3Value,
  slotsFromTrace,
  type CallTrace,
} from './bulk-call.js';
import { validateEvmCall } from './call-validation.js';
import { ERC20_ABI, buildErc20TransferCall } from './erc20.js';
import { extractMessage, isDefinitiveRefusal, isRpcOutage, mapBaseFailure } from './error-mapping.js';
import { bumpFeeFields, estimateFeeFields } from './fee-estimation.js';
import { NATIVE_ASSET_SYMBOL, resolveKnownToken, type BaseTokenRegistry } from './known-tokens.js';
import { buildNativeTransferCall } from './native-transfer.js';
import { NonceCounter } from './nonce-authority.js';
import {
  decodeUnsignedTransaction,
  encodeUnsignedTransaction,
  signedTransactionHex,
  toViemTransaction,
  type EncodedEvmTransaction,
} from './transaction-codec.js';

/** issue 05: what `prepare` falls back to when `eth_estimateGas` fails (a simulated revert) — generous enough for any call this handler realistically submits, comfortably under Base's block gas limit. */
const FALLBACK_GAS_LIMIT = 500_000n;

export type BaseChainHandlerDeps = {
  rpcUrl: string;
  /** Verified against the connected RPC's own eth_chainId in `create()` — refuses to construct on mismatch. */
  chainId: number;
  /** Single-Sender-per-chain (ADR-0016) — the wallet paymentToCall encodes transfers from, and whose next-nonce this handler owns (issue 02). */
  senderAddress: string;
  /**
   * Only needed if this handler ever builds+signs a Managed Dispatch
   * transaction (`sign`). A Relay-Dispatch-only deployment never calls
   * `sign` (the transaction always arrives already signed, ADR-0005) and
   * can omit this, mirroring SolanaChainHandlerDeps.
   */
  signerClient?: SignerClient;
  /** Operator-configured symbol -> {contractAddress, decimals} for ERC-20 transfers (known-tokens.ts) — empty by default. */
  knownTokens?: BaseTokenRegistry;
  /** issue 02: persisted per-Sender nonce->hash history — populated once broadcast exists (issue 03), consumed by no logic yet. */
  nonceHistoryStore: NonceHistoryStore;
  /** issue 09: minimum percentage both fee fields must be bumped by on a Retry Policy fee-bump replacement. */
  feeBumpPercent?: number;
  /** issue 11: max items per Bulk Call transaction before the engine splits a request across multiple. */
  bulkCallMaxBatchSize?: number;
  /** #11 (ADR-0038): a tracing-capable RPC for Bulk Call's per-item outcomes. Without it Bulk Call is off: validateBulkCall rejects, and getBundleStatus isn't there. */
  traceRpcUrl?: string;
  /** Injectable for the RPC client's transport (issue 15's shared per-call deadline, and test doubles). Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Defaults to the shared app logger under a `component: 'base-chain-handler'` binding. Injectable so tests/tools can point it elsewhere. */
  logger?: Logger;
};

/**
 * The Coordinator's `abandonmentTimeoutMs` config value for `'base'`
 * (ADR-0004) — EVM has no protocol-provable dead end the way Solana's
 * blockhash expiry does (research-base.md §8), so this is a plain,
 * chain-aware probabilistic default (ADR-0004's own "~10-15min" EVM
 * estimate), not backed by a provable-expiry check the way Solana's
 * `getStatus` resolves most stuck transactions before this ever fires.
 */
export const BASE_ABANDONMENT_TIMEOUT_MS = 15 * 60_000;

/**
 * issue 07: the Coordinator's `reorgRecheckWindowMs` config value for
 * 'base' — how long after being marked CONFIRMED a transaction stays
 * eligible for the reorg safety net's background re-check. A fixed time
 * window standing in for "past OP Stack 'safe'" (research-base.md §4:
 * ~2 minutes), not a dynamic safe-head query (ADR-0036). Several times
 * that lag, so a transaction gets several re-checks after its block has
 * actually reached 'safe' — chain-loaders.ts enforces it spans at least
 * three re-check intervals.
 */
export const BASE_REORG_RECHECK_WINDOW_MS = 10 * 60_000;

function requireAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`not a well-formed EVM address: ${value}`);
  }
  return value;
}

/** The `Result`-returning counterpart to `requireAddress` — for a request-shaped (not construction-time) malformed-address check, which must answer INVALID_RECIPIENT rather than throw. */
function requireAddressResult(value: string): Result<Address, DispatchError> {
  if (!isAddress(value)) {
    return err({ code: 'INVALID_RECIPIENT', message: `not a well-formed EVM address: ${value}` });
  }
  return ok(value);
}

/** EIP-2's upper bound for a signature's s value: half the secp256k1 curve order. */
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_N = SECP256K1_N / 2n;

function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** #13: the address a signed transaction's signature recovers to — pure secp256k1, no RPC. */
async function recoverSender(hex: `0x${string}`): Promise<Result<Address, DispatchError>> {
  try {
    return ok(await recoverTransactionAddress({ serializedTransaction: hex as TransactionSerializedEIP1559 }));
  } catch (cause) {
    return err({
      code: 'CHAIN_REJECTED',
      message: 'signature does not recover to any sender',
      chainDetail: { error: extractMessage(cause) },
    });
  }
}

/**
 * The second real Chain Handler (`.scratch/base-chain-handler/spec.md`).
 * Built incrementally, issue by issue — see each method's doc comment for
 * which issue it belongs to. Constructed only via the async `create()`
 * factory (never `new` directly, kept private): chain-ID verification
 * (issue 01) and the nonce counter's initial read (issue 02) both require
 * an RPC round-trip, which a synchronous constructor can't await.
 */
export class BaseChainHandler implements ChainHandler<'base'> {
  readonly chain = 'base';

  private readonly client: PublicClient;
  private readonly chainId: number;
  private readonly senderAddress: Address;
  private readonly signerClient: SignerClient | undefined;
  private readonly knownTokens: BaseTokenRegistry;
  private readonly nonceHistoryStore: NonceHistoryStore;
  private readonly feeBumpPercent: number;
  private readonly bulkCallMaxBatchSize: number;
  private readonly traceClient: PublicClient | undefined;
  private readonly logger: Logger;

  /** #11: present only with a tracing RPC — the Coordinator reads its presence as "per-item outcomes are available". */
  readonly getBundleStatus?: (hash: string) => Promise<Result<BundleSlotStatus[], DispatchError>>;

  /** #24: nonces `sign` assigned whose transaction hasn't been sent yet — the only ones a refused broadcast may release. */
  private readonly unsentNonces = new Set<number>();

  /** issue 02: the single next-nonce authority for `senderAddress` (nonce-authority.ts) — assigned in-process, never via a per-request `eth_getTransactionCount("pending")` read, so concurrent Managed Dispatch submissions can't collide or skip (ADR-0002's single-nonce-authority requirement). */
  private readonly nonceCounter: NonceCounter;

  private constructor(
    deps: BaseChainHandlerDeps & { client: PublicClient; senderAddress: Address },
    initialNonce: number,
  ) {
    this.client = deps.client;
    this.chainId = deps.chainId;
    this.senderAddress = deps.senderAddress;
    this.signerClient = deps.signerClient;
    this.knownTokens = deps.knownTokens ?? {};
    this.nonceHistoryStore = deps.nonceHistoryStore;
    this.feeBumpPercent = deps.feeBumpPercent ?? 15;
    this.bulkCallMaxBatchSize = deps.bulkCallMaxBatchSize ?? 50;
    this.traceClient = deps.traceRpcUrl
      ? createPublicClient({ transport: http(deps.traceRpcUrl, { fetchFn: deps.fetch ?? fetch }) })
      : undefined;
    if (this.traceClient) {
      const traceClient = this.traceClient;
      this.getBundleStatus = (hash) => this.readBundleStatus(traceClient, hash);
    }
    this.logger = (deps.logger ?? defaultLogger).child({ component: 'base-chain-handler' });
    this.nonceCounter = new NonceCounter(initialNonce);
  }

  /**
   * issue 01: verifies the configured `chainId` against the connected RPC's
   * own `eth_chainId` before this handler is ever usable — refusing to
   * start on a mismatch (a misconfigured network must never sign/broadcast
   * for the wrong chain, CONTEXT.md's Chain entry). issue 02: also reads
   * this Sender's confirmed nonce once, to initialize the in-process
   * counter `assignNextNonce` (below) then owns for the rest of this
   * handler's life.
   */
  static async create(deps: BaseChainHandlerDeps): Promise<BaseChainHandler> {
    const senderAddress = requireAddress(deps.senderAddress);
    const client = createPublicClient({
      transport: http(deps.rpcUrl, { fetchFn: deps.fetch ?? fetch }),
    });

    const actualChainId = await client.getChainId();
    if (actualChainId !== deps.chainId) {
      throw new Error(
        `BaseChainHandler configured for chain ID ${deps.chainId} but ${deps.rpcUrl} answered eth_chainId ${actualChainId} — refusing to start against a mismatched network.`,
      );
    }

    // #20 (ADR-0041): never below what this Sender still has in its
    // mempool. Nonces written down but never sent are reserved separately,
    // from the engine's own rows (restoreInFlight), once the worker starts.
    const [confirmed, pending] = await Promise.all([
      client.getTransactionCount({ address: senderAddress, blockTag: 'latest' }),
      client.getTransactionCount({ address: senderAddress, blockTag: 'pending' }),
    ]);
    const initialNonce = Math.max(confirmed, pending);

    return new BaseChainHandler({ ...deps, client, senderAddress }, initialNonce);
  }

  /**
   * issue 02: re-reads this Sender's confirmed nonce from the chain and
   * corrects the in-process counter if it's drifted (e.g. a broadcast
   * failed with a nonce-mismatch-shaped RPC error, or this process
   * restarted). Never called on the happy path — `nonceCounter.assignNext`
   * is.
   */
  /** #10: moves the counter forward to the chain's confirmed nonce, never back (NonceCounter.advanceTo). */
  private async catchUpNonce(): Promise<void> {
    const latest = await this.client.getTransactionCount({
      address: this.senderAddress,
      blockTag: 'latest',
    });
    if (latest > this.nonceCounter.peek()) {
      this.logger.warn({ previousNextNonce: this.nonceCounter.peek(), advancedTo: latest }, 'advancing nonce counter to the chain');
    }
    this.nonceCounter.advanceTo(latest);
  }

  private async resyncNonce(): Promise<void> {
    const latest = await this.client.getTransactionCount({
      address: this.senderAddress,
      blockTag: 'latest',
    });
    this.logger.warn(
      { previousNextNonce: this.nonceCounter.peek(), resyncedTo: latest },
      'resyncing nonce counter from eth_getTransactionCount',
    );
    this.nonceCounter.resyncTo(latest);
  }

  /** issues 03/04: encodes a plain transfer (native or a known ERC-20 token) as an EvmCall. No RPC (ADR-0028). */
  paymentToCall(payment: Payment): Promise<Result<CallForChain<'base'>, DispatchError>> {
    if (payment.asset === NATIVE_ASSET_SYMBOL) {
      return Promise.resolve(buildNativeTransferCall(payment.recipient, payment.amount));
    }

    const token = resolveKnownToken(this.knownTokens, payment.asset);
    if (!token) {
      return Promise.resolve(
        err({
          code: 'UNKNOWN_ASSET',
          message: `no known token configured for asset "${payment.asset}"`,
          chainDetail: { asset: payment.asset },
        }),
      );
    }

    return Promise.resolve(
      buildErc20TransferCall(token.contractAddress, payment.recipient, BigInt(payment.amount)),
    );
  }

  /** issues 03/05: cheap shape validation only, the same for every EvmCall regardless of where it came from (call-validation.ts). Never an RPC round-trip. */
  validateCall(call: EvmCall): Promise<Result<void, DispatchError>> {
    return Promise.resolve(validateEvmCall(call));
  }

  /**
   * issue 03: builds one unsigned EIP-1559 transaction per input Call, in
   * order — chain ID and a freshly assigned nonce (nonce-authority.ts)
   * baked into each, fee fields from the fixed-multiplier heuristic
   * (fee-estimation.ts), which reads `baseFeePerGas` once for the whole
   * batch, not once per item. issue 05: a raw caller-supplied EvmCall gets
   * no special-casing — its `data` travels through exactly as opaque bytes
   * (ADR-0018/0027), so this method never distinguishes a transfer from an
   * arbitrary contract call.
   */
  async prepare(
    items: EvmCall[],
    senderAddress: string,
    options?: PrepareOptions,
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    const sender = requireAddressResult(senderAddress);
    if (!sender.ok) return sender;
    if (options?.bulkCall) return this.prepareBulk(items, sender.value, options.bulkCall);

    const baseFee = await this.latestBaseFeePerGas();
    if (!baseFee.ok) return baseFee;
    const { maxFeePerGas, maxPriorityFeePerGas } = estimateFeeFields(baseFee.value);

    const prepared: PreparedTransaction[] = [];
    for (let callIndex = 0; callIndex < items.length; callIndex++) {
      const call = items[callIndex];
      if (!call) continue;

      const to = requireAddressResult(call.to);
      if (!to.ok) return to;

      // Always estimated, never shortcut to a fixed 21,000 for empty
      // calldata: a raw caller-supplied EvmCall (issue 05) with `data: "0x"`
      // isn't necessarily a plain EOA transfer — it could target a
      // contract with a non-trivial payable fallback, which a hardcoded
      // 21,000 would under-fund into an out-of-gas revert. A real plain
      // transfer estimates to exactly 21,000 anyway (confirmed against
      // real Base Sepolia), so this costs one extra RPC round trip for
      // that case rather than a latent bug for every other one.
      let gas: bigint;
      try {
        gas = await this.client.estimateGas({
          account: sender.value,
          to: to.value,
          data: call.data as `0x${string}`,
          value: BigInt(call.value),
        });
      } catch (cause) {
        // #10: an outage (rate limit, timeout — which can start mid-batch,
        // after getBlock succeeded) is not a simulated revert: surfaced,
        // never papered over with a guessed gas limit (ADR-0010).
        if (isRpcOutage(cause)) return err(mapBaseFailure(cause));
        // issue 05: `eth_estimateGas` simulates the call and throws if it
        // would revert — but this handler never interprets a Call's
        // semantics, including whether it succeeds (ADR-0018/0027), so a
        // call that would revert is still submitted, exactly like any
        // other. Falls back to a generous fixed gas limit (comfortably
        // under Base's block gas limit) so the real on-chain outcome —
        // success or revert — is what actually gets reported, not a
        // pre-emptive guess made here.
        this.logger.warn(
          { error: extractMessage(cause) },
          'estimateGas failed (likely a simulated revert) — falling back to a fixed gas limit so the real on-chain outcome is what gets reported',
        );
        gas = FALLBACK_GAS_LIMIT;
      }

      const encoded: EncodedEvmTransaction = {
        senderAddress: sender.value,
        chainId: this.chainId,
        nonce: null, // assigned at sign time (#24)
        to: to.value,
        value: call.value,
        data: call.data as EncodedEvmTransaction['data'],
        gas: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        preparedId: randomUUID(),
      };
      prepared.push({ callIndex, unsignedTransaction: encodeUnsignedTransaction(encoded) });
    }

    return ok(prepared);
  }

  /**
   * issue 03: rebuilds the exact unsigned transaction `prepare` encoded,
   * re-derives its signing hash (`keccak256` of the unsigned serialized
   * bytes — EIP-1559's own signing-hash definition), and delegates to the
   * Signer client (ADR-0002) for a raw recoverable signature over that
   * exact digest (reference-signer's own `r||s||recovery` contract — see
   * its `sign.ts` doc comment). Folds the returned signature back into a
   * fully signed transaction via viem.
   */
  async sign(
    prepared: PreparedTransaction,
    senderAddress: string,
  ): Promise<Result<SignedTransaction, DispatchError>> {
    let encoded: EncodedEvmTransaction;
    try {
      encoded = decodeUnsignedTransaction(prepared.unsignedTransaction);
    } catch (cause) {
      return err({ ...mapBaseFailure(cause), code: 'CHAIN_REJECTED' });
    }
    if (encoded.senderAddress.toLowerCase() !== senderAddress.toLowerCase()) {
      return err({
        code: 'INVALID_RECIPIENT',
        message: `PreparedTransaction was built for ${encoded.senderAddress}, asked to sign as ${senderAddress}`,
      });
    }
    if (!this.signerClient) {
      this.logger.warn({ senderAddress }, 'asked to sign but no Signer is configured for this ChainHandler');
      return err({
        code: 'SIGNER_UNREACHABLE',
        message:
          'no Signer configured for this ChainHandler — a Relay-Dispatch-only deployment never signs, so signerClient was never provided',
      });
    }

    // #24 (ADR-0039): the nonce is assigned here, the moment the
    // transaction is actually about to go out — not in prepare — and handed
    // straight back if signing fails, so no gap ever forms at it. A
    // fee-bump replacement arrives with its stuck predecessor's nonce.
    const assigned = encoded.nonce === null;
    const nonce = encoded.nonce ?? this.nonceCounter.assignNext();
    const fail = (error: DispatchError): Result<SignedTransaction, DispatchError> => {
      if (assigned) this.nonceCounter.release(nonce);
      return err(error);
    };

    // #10: viem's own serialization checks (e.g. a tip above the fee cap)
    // throw on bad input — answered as a structured error.
    let tx: ReturnType<typeof toViemTransaction>;
    let signingHash: `0x${string}`;
    try {
      tx = toViemTransaction(encoded, nonce);
      signingHash = keccak256(serializeTransaction(tx));
    } catch (cause) {
      return fail({ ...mapBaseFailure(cause), code: 'CHAIN_REJECTED' });
    }

    const signResult = await this.signerClient.requestSignature({
      chain: 'base',
      curve: 'secp256k1',
      address: senderAddress,
      unsignedTxBytes: Buffer.from(signingHash.slice(2), 'hex').toString('base64'),
    });
    if (!signResult.ok) {
      this.logger.warn({ error: signResult.error }, 'signer request failed');
      return fail(signResult.error);
    }

    const signatureBytes = Buffer.from(signResult.value.signature, 'base64');
    if (signatureBytes.length !== 65) {
      return fail({
        code: 'SIGNER_UNREACHABLE',
        message: `signer returned a ${signatureBytes.length}-byte signature, expected 65 (r||s||recovery)`,
      });
    }
    const r = `0x${signatureBytes.subarray(0, 32).toString('hex')}` as const;
    let sValue = BigInt(`0x${signatureBytes.subarray(32, 64).toString('hex')}`);
    let yParity = signatureBytes[64] ?? 0;
    // #24 review: some Signers (e.g. cloud KMS) return a high-s signature,
    // which every node refuses (EIP-2). Its low-s twin is equally valid —
    // normalize rather than send bytes that can only be refused.
    if (sValue > SECP256K1_HALF_N) {
      sValue = SECP256K1_N - sValue;
      yParity = yParity === 0 ? 1 : 0;
    }
    const s = `0x${sValue.toString(16).padStart(64, '0')}` as const;

    const signed = serializeTransaction(tx, { r, s, yParity });
    if (assigned) this.unsentNonces.add(nonce);
    return ok(signed);
  }


  /**
   * #9 (ADR-0037): an unsigned replacement for a stuck transaction — the
   * same nonce, recipient, value, data and gas, decoded straight from its
   * signed bytes, with both fee fields raised per `bumpFeeFields`
   * (fee-estimation.ts): at least `feeBumpPercent` above the old values,
   * never below a fresh estimate. `NONCE_ALREADY_USED` when the Sender's
   * confirmed nonce has already moved past it — some version landed, and
   * a replacement could only ever be rejected.
   */
  async prepareReplacement(
    signed: SignedTransaction,
    senderAddress: string,
  ): Promise<Result<PreparedTransaction, DispatchError>> {
    const sender = requireAddressResult(senderAddress);
    if (!sender.ok) return sender;

    const decodedSigned = this.decodeSigned(signed);
    if (!decodedSigned.ok) return decodedSigned;
    const decoded = decodedSigned.value.tx;
    const { nonce, to, gas, maxFeePerGas, maxPriorityFeePerGas } = decoded;
    if (!to || gas === undefined || maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'cannot replace: not a complete EIP-1559 transaction',
        chainDetail: { nonce, to, gas: gas?.toString() },
      });
    }

    let confirmedNonce: number;
    try {
      confirmedNonce = await this.client.getTransactionCount({ address: sender.value, blockTag: 'latest' });
    } catch (cause) {
      return err(mapBaseFailure(cause));
    }
    if (confirmedNonce > nonce) {
      return err({
        code: 'NONCE_ALREADY_USED',
        message: `nonce ${nonce} already consumed on-chain (confirmed nonce is ${confirmedNonce})`,
        chainDetail: { nonce, confirmedNonce },
      });
    }

    const baseFee = await this.latestBaseFeePerGas();
    if (!baseFee.ok) return baseFee;
    const fees = bumpFeeFields(
      { maxFeePerGas, maxPriorityFeePerGas },
      estimateFeeFields(baseFee.value),
      this.feeBumpPercent,
    );
    this.logger.info(
      { nonce, from: { maxFeePerGas, maxPriorityFeePerGas }, to: fees },
      'prepared fee-bump replacement',
    );

    const encoded: EncodedEvmTransaction = {
      senderAddress: sender.value,
      chainId: this.chainId,
      nonce,
      to,
      value: (decoded.value ?? 0n).toString(),
      data: decoded.data ?? '0x',
      gas: gas.toString(),
      maxFeePerGas: fees.maxFeePerGas.toString(),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas.toString(),
      preparedId: randomUUID(),
    };
    return ok({ callIndex: 0, unsignedTransaction: encodeUnsignedTransaction(encoded) });
  }

  /** The latest block's `baseFeePerGas` — what both `prepare` and `prepareReplacement` estimate fees from. */
  private async latestBaseFeePerGas(): Promise<Result<bigint, DispatchError>> {
    try {
      const block = await this.client.getBlock();
      if (block.baseFeePerGas === null) {
        return err({
          code: 'RPC_UNAVAILABLE',
          message: 'latest Base block has no baseFeePerGas — pre-EIP-1559 RPC response?',
        });
      }
      return ok(block.baseFeePerGas);
    } catch (cause) {
      return err(mapBaseFailure(cause));
    }
  }

  /**
   * #11 (ADR-0038): a Bulk Call request checked against its items before
   * anything is persisted. ERC-20 payments are funded by the aggregator
   * itself (inside aggregate3Value, msg.sender is the aggregator) — and so
   * refused outright for the canonical, permissionless Multicall3, where no
   * balance or approval of the caller's could ever be safe.
   */
  async validateBulkCall(
    request: BulkCallRequest,
    items: DispatchItem<'base'>[],
  ): Promise<Result<BulkCallPlan, DispatchError>> {
    const allowFailure = request.allowFailure ?? false;
    // Only per-item outcomes (allowFailure: true) need a trace: with false,
    // the receipt alone says what happened to every item.
    if (allowFailure && !this.traceClient) {
      return err({
        code: 'CHAIN_REJECTED',
        message:
          'allowFailure: true needs a tracing RPC (BASE_TRACE_RPC_URL) to read per-item outcomes — omit it, or set it false, to have any failing item fail its whole chunk instead',
      });
    }
    const checked = requireAddressResult(request.aggregator);
    if (!checked.ok) return checked;
    // Checksummed, so the same aggregator in any letter case is one payer to the Funding Check.
    const aggregator = getAddress(checked.value);
    // An EOA "aggregator" would take the whole native total and run nothing.
    try {
      const code = await this.client.getCode({ address: aggregator });
      if (!code || code === '0x') {
        return err({
          code: 'INVALID_RECIPIENT',
          message: `aggregator ${aggregator} has no contract code on this network`,
          chainDetail: { aggregator },
        });
      }
    } catch (cause) {
      return err(mapBaseFailure(cause));
    }
    const maxBatchSize = request.maxBatchSize ?? this.bulkCallMaxBatchSize;
    if (!Number.isInteger(maxBatchSize) || maxBatchSize < 1 || maxBatchSize > this.bulkCallMaxBatchSize) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `maxBatchSize must be 1..${this.bulkCallMaxBatchSize}`,
        chainDetail: { maxBatchSize },
      });
    }
    const fundedBy = items.map((item) =>
      item.payment && item.payment.asset !== NATIVE_ASSET_SYMBOL ? aggregator : null,
    );
    if (isSameAddress(aggregator, CANONICAL_MULTICALL3) && fundedBy.some((f) => f !== null)) {
      return err({
        code: 'CHAIN_REJECTED',
        message:
          'ERC-20 items cannot go through the canonical Multicall3: it is permissionless, so any token balance or approval it holds can be taken by anyone — name your own aggregator',
        chainDetail: { aggregator },
      });
    }
    return ok({ bulkCall: { aggregator, maxBatchSize, allowFailure }, fundedBy });
  }

  /**
   * #11: one `aggregate3Value` transaction per chunk of `maxBatchSize`
   * items, each chunk at its own nonce, sending the aggregator the chunk's
   * total native value to forward. Every item in a chunk gets the chunk's
   * identical unsignedTransaction, which is what makes the Coordinator
   * broadcast it once, with one row per item.
   */
  private async prepareBulk(
    items: EvmCall[],
    sender: Address,
    bulkCall: BulkCall,
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    const aggregator = requireAddressResult(bulkCall.aggregator);
    if (!aggregator.ok) return aggregator;
    const baseFee = await this.latestBaseFeePerGas();
    if (!baseFee.ok) return baseFee;
    const { maxFeePerGas, maxPriorityFeePerGas } = estimateFeeFields(baseFee.value);

    const prepared: PreparedTransaction[] = [];
    let callIndex = 0;
    for (const calls of chunk(items, bulkCall.maxBatchSize)) {
      const { data, value } = encodeAggregate3Value(calls, bulkCall.allowFailure);
      let gas: bigint;
      try {
        gas = await this.client.estimateGas({ account: sender, to: aggregator.value, data, value });
      } catch (cause) {
        if (isRpcOutage(cause)) return err(mapBaseFailure(cause));
        // A failed estimate means the whole call would revert — with
        // allowFailure false, any one bad item does that; with true, only
        // the aggregator refusing the call. Still sent, so the chain answers
        // (ADR-0018: never pre-judged here).
        this.logger.warn({ error: extractMessage(cause) }, 'bulk estimateGas failed — using the fallback gas limit');
        gas = FALLBACK_GAS_LIMIT;
      }
      const unsignedTransaction = encodeUnsignedTransaction({
        senderAddress: sender,
        chainId: this.chainId,
        nonce: null, // assigned at sign time (#24)
        to: aggregator.value,
        value: value.toString(),
        data,
        gas: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
        preparedId: randomUUID(), // one per chunk: its members share these bytes
      });
      for (let i = 0; i < calls.length; i++) prepared.push({ callIndex: callIndex++, unsignedTransaction });
    }
    return ok(prepared);
  }

  /**
   * #11: each bundled item's outcome, from the trace. PENDING until mined;
   * a reverted bundle fails every slot; otherwise each slot is its own
   * sub-call's outcome (bulk-call.ts). The slot count comes from the
   * transaction's own calldata.
   */
  private async readBundleStatus(
    traceClient: PublicClient,
    hash: string,
  ): Promise<Result<BundleSlotStatus[], DispatchError>> {
    const status = await this.getStatus(hash);
    if (!status.ok) return status;
    try {
      let input: `0x${string}`;
      try {
        input = (await this.client.getTransaction({ hash: hash as `0x${string}` })).input;
      } catch (cause) {
        // Not known to this node yet (just sent, or a fee-bump version that
        // never landed): nothing to report — every slot is still pending.
        if (cause instanceof TransactionNotFoundError && status.value === 'PENDING') return ok([]);
        throw cause;
      }
      const itemCount = decodeFunctionData({ abi: AGGREGATE3_VALUE_ABI, data: input }).args[0].length;
      const every = (slot: BundleSlotStatus) => Array.from({ length: itemCount }, () => slot);
      if (status.value === 'PENDING') return ok(every({ status: 'PENDING' }));
      // A reverted bundle fails every slot — the receipt alone proves it, no trace needed.
      if (status.value === 'FAILED') return ok(every({ status: 'FAILED', detail: { error: 'bundle reverted' } }));
      // debug_* isn't in viem's typed method list, hence the untyped request.
      const request = traceClient.request as (args: {
        method: string;
        params: unknown[];
      }) => Promise<unknown>;
      const trace = (await request({
        method: 'debug_traceTransaction',
        params: [hash, { tracer: 'callTracer' }],
      })) as CallTrace;
      return slotsFromTrace(trace, itemCount);
    } catch (cause) {
      return err(mapBaseFailure(cause));
    }
  }


  /** #20 (ADR-0041): an EIP-1559 transaction's hash is keccak256 of its signed serialization — exactly what eth_sendRawTransaction reports. */
  transactionHash(signed: SignedTransaction): Result<string, DispatchError> {
    const hex = signedTransactionHex(signed);
    if (!hex) {
      return err({ code: 'CHAIN_REJECTED', message: 'signed transaction is neither 0x-hex nor base64 bytes' });
    }
    return ok(keccak256(hex));
  }

  /**
   * #20 review (ADR-0041): moves the counter past every nonce this Sender
   * holds among the engine's in-flight Transactions — including one
   * written down but never sent before a crash, which recovery will send
   * later. Bytes signed by anyone else (Relay Dispatch) are ignored.
   */
  async restoreInFlight(signed: SignedTransaction[]): Promise<void> {
    let highest = -1;
    for (const bytes of signed) {
      const decoded = this.decodeSigned(bytes);
      if (!decoded.ok) continue;
      const sender = await recoverSender(decoded.value.hex);
      if (sender.ok && isSameAddress(sender.value, this.senderAddress)) {
        highest = Math.max(highest, decoded.value.tx.nonce);
      }
    }
    if (highest >= 0) this.nonceCounter.advanceTo(highest + 1);
  }

  /**
   * #13 (ADR-0032): RPC-free proof that a Relay Dispatch submission really
   * is a Base transaction this network will consider — an EIP-1559 (type
   * 0x02) transaction for this handler's chain ID, carrying a signature a
   * sender address actually recovers from. Never judges what it does.
   */
  async validateSignedTransaction(signed: SignedTransaction): Promise<Result<void, DispatchError>> {
    const decoded = this.decodeSigned(signed);
    if (!decoded.ok) return decoded;
    const sender = await recoverSender(decoded.value.hex);
    return sender.ok ? ok(undefined) : sender;
  }

  /**
   * #13: decodes signed bytes of either origin — this handler's own `sign`
   * (0x-hex) or a Relay Dispatch caller (base64) — into a complete
   * EIP-1559 transaction for this handler's chain ID, or a structured error.
   */
  private decodeSigned(
    signed: SignedTransaction,
  ): Result<{ hex: `0x${string}`; tx: TransactionSerializableEIP1559 & { nonce: number } }, DispatchError> {
    const hex = signedTransactionHex(signed);
    if (!hex) {
      return err({ code: 'CHAIN_REJECTED', message: 'signed transaction is neither 0x-hex nor base64 bytes' });
    }
    let decoded: ReturnType<typeof parseTransaction>;
    try {
      decoded = parseTransaction(hex);
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'not a decodable signed transaction',
        chainDetail: { error: extractMessage(cause) },
      });
    }
    if (decoded.type !== 'eip1559') {
      return err({
        code: 'CHAIN_REJECTED',
        message: `only EIP-1559 (type 0x02) transactions are accepted, got ${decoded.type}`,
        chainDetail: { type: decoded.type },
      });
    }
    if (decoded.chainId !== this.chainId) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `signed for chain ID ${decoded.chainId}, this network is ${this.chainId}`,
        chainDetail: { chainId: decoded.chainId, expectedChainId: this.chainId },
      });
    }
    if (decoded.nonce === undefined || decoded.r === undefined || decoded.s === undefined) {
      return err({ code: 'CHAIN_REJECTED', message: 'signed transaction is missing its nonce or signature' });
    }
    // EIP-2: a high-s signature still recovers, but every node refuses it.
    if (BigInt(decoded.s) > SECP256K1_HALF_N) {
      return err({ code: 'CHAIN_REJECTED', message: 'signature has a high s value (EIP-2) — nodes refuse it' });
    }
    return ok({ hex, tx: { ...decoded, nonce: decoded.nonce } });
  }

  /**
   * issue 03: broadcasts via `eth_sendRawTransaction` and records the
   * (nonce, hash) pair into issue 02's persisted history on success. The
   * nonce/chainId are decoded straight from the signed bytes rather than
   * re-derived from whatever this handler happens to have in memory — the
   * same no-RPC decode `validateSignedTransaction`/Relay Dispatch (issue
   * 13) will reuse for externally-signed bytes (ADR-0033 precedent).
   */
  async broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> {
    const decoded = this.decodeSigned(signed);
    if (!decoded.ok) return decoded;
    const { hex } = decoded.value;
    const { nonce } = decoded.value.tx;
    // #13: whoever signed it — this Sender for a Managed Dispatch, the
    // Relay Dispatch caller's own signing address otherwise. Recovered from the bytes,
    // no RPC (ADR-0033 precedent).
    const sender = await recoverSender(hex);
    if (!sender.ok) {
      // A local refusal of bytes this handler signed: the nonce never went out.
      if (this.unsentNonces.delete(nonce)) this.nonceCounter.release(nonce);
      return sender;
    }

    let hash: string;
    try {
      hash = await this.client.sendRawTransaction({ serializedTransaction: hex });
    } catch (cause) {
      this.logger.warn({ error: extractMessage(cause) }, 'sendRawTransaction failed');
      const error = mapBaseFailure(cause);
      // #24 (ADR-0039): a send the node definitively refused never
      // consumed its nonce — hand it back so the Sender's next transaction
      // doesn't queue behind a gap forever. Only for a nonce this handler
      // just assigned and never sent before (so never a rebroadcast of one
      // already in a mempool), and never on an ambiguous failure: a timed-
      // out send may still have reached the node.
      if (
        isSameAddress(sender.value, this.senderAddress) &&
        this.unsentNonces.delete(nonce) &&
        isDefinitiveRefusal(error)
      ) {
        if (this.nonceCounter.release(nonce)) {
          this.logger.info({ nonce, error: error.message }, 'broadcast refused — nonce released, no gap');
        }
      }
      // #10: the chain is ahead of our counter (e.g. something else sent
      // from this Sender) — catch up, or every later Managed send fails
      // the same way. Forward only: also expected after a fee-bump race,
      // when later nonces may already be in flight.
      if (error.code === 'NONCE_ALREADY_USED' && isSameAddress(sender.value, this.senderAddress)) {
        await this.catchUpNonce().catch((catchUpCause: unknown) =>
          this.logger.error({ error: extractMessage(catchUpCause) }, 'nonce catch-up failed'),
        );
      }
      return err(error);
    }

    this.unsentNonces.delete(nonce);
    // #10: the transaction is already on-chain at this point — a failed
    // history write must never turn that into an error, or the Coordinator
    // would lose the hash of a transaction that may land. Logged loudly
    // instead (ADR-0010: surfaced, not swallowed).
    try {
      await this.nonceHistoryStore.recordNonce({
        chain: 'base',
        senderAddress: sender.value,
        nonce,
        hash,
      });
    } catch (cause) {
      this.logger.error(
        { hash, nonce, error: extractMessage(cause) },
        'broadcast succeeded but recording its nonce history failed',
      );
    }
    this.logger.info({ hash, nonce }, 'transaction broadcast');
    return ok({ hash });
  }

  /**
   * issue 06: `eth_getTransactionReceipt` — `status: 1` -> `CONFIRMED`,
   * reported as soon as the transaction's block is included (~2s),
   * deliberately not waiting for OP Stack "safe" head (issue 07's own
   * background safety net covers the rare reorg risk this trades away,
   * without ever delaying this report — that's the whole point of Base's
   * speed). `status: 0` -> `FAILED`. No receipt yet (viem throws
   * `TransactionReceiptNotFoundError` rather than returning `null`) ->
   * `PENDING`, until the Coordinator's existing generic abandonment
   * timeout (ADR-0004) resolves it to `ABANDONED` (issue 08) — no EVM-
   * specific timeout logic added here or anywhere in this handler.
   */
  async getStatus(hash: string): Promise<Result<ChainStatus, DispatchError>> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash: hash as `0x${string}` });
      const status: ChainStatus = receipt.status === 'success' ? 'CONFIRMED' : 'FAILED';
      this.logger.debug({ hash, status }, 'getStatus');
      return ok(status);
    } catch (cause) {
      if (cause instanceof TransactionReceiptNotFoundError) {
        this.logger.debug({ hash }, 'getStatus: PENDING (no receipt yet)');
        return ok('PENDING');
      }
      return err(mapBaseFailure(cause));
    }
  }

  /** issue 04: native ETH via eth_getBalance; a known ERC-20 token via a balanceOf eth_call — feeds the Funding Check (ADR-0024) unchanged. */
  async getBalance(address: string, asset: string): Promise<Result<Balance, DispatchError>> {
    const owner = requireAddressResult(address);
    if (!owner.ok) return owner;

    try {
      if (asset === NATIVE_ASSET_SYMBOL) {
        const wei = await this.client.getBalance({ address: owner.value });
        return ok({ asset, amount: wei.toString() });
      }

      const token = resolveKnownToken(this.knownTokens, asset);
      if (!token) {
        return err({
          code: 'UNKNOWN_ASSET',
          message: `no known token configured for asset "${asset}"`,
          chainDetail: { asset },
        });
      }

      const balance = await this.client.readContract({
        address: requireAddress(token.contractAddress),
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [owner.value],
      });
      return ok({ asset, amount: balance.toString() });
    } catch (cause) {
      return err(mapBaseFailure(cause));
    }
  }

  /** Test-only inspection — not part of ChainHandler. The value `prepare` (issue 03) will assign next. */
  peekNextNonce(): number {
    return this.nonceCounter.peek();
  }

  /** Test-only — not part of ChainHandler. Exercises the same no-RPC assignment path `prepare` (issue 03) will use. */
  testOnlyAssignNextNonce(): number {
    return this.nonceCounter.assignNext();
  }

  /** Test-only — not part of ChainHandler. Exercises issue 02's full resync path directly (no production caller: broadcast only ever catches up, via catchUpNonce). */
  testOnlyResyncNonce(): Promise<void> {
    return this.resyncNonce();
  }
}
