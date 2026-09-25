import {
  TransactionReceiptNotFoundError,
  createPublicClient,
  http,
  isAddress,
  keccak256,
  parseTransaction,
  serializeTransaction,
  type Address,
  type PublicClient,
} from 'viem';
import type { Logger } from 'pino';

import type { CallForChain, EvmCall, Payment } from '../../domain/call.js';
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
  SignedTransaction,
} from '../chain-handler.js';
import { validateEvmCall } from './call-validation.js';
import { ERC20_ABI, buildErc20TransferCall } from './erc20.js';
import { extractMessage, mapBaseFailure } from './error-mapping.js';
import { bumpFeeFields, estimateFeeFields } from './fee-estimation.js';
import { NATIVE_ASSET_SYMBOL, resolveKnownToken, type BaseTokenRegistry } from './known-tokens.js';
import { buildNativeTransferCall } from './native-transfer.js';
import { NonceCounter } from './nonce-authority.js';
import {
  decodeUnsignedTransaction,
  encodeUnsignedTransaction,
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

/**
 * `base` isn't reachable via `ENABLED_CHAINS` until every issue lands
 * (ADR-0019), so nothing should call one of these stubs for real — this
 * throws rather than returning a `DispatchError` because "this method has
 * no logic yet" is a build-time bug, not a business outcome a caller
 * should branch on (ADR-0010's own distinction), unlike a real
 * `CHAIN_REJECTED`.
 */
function notImplemented(method: string, issueNumber: number): Error {
  return new Error(
    `BaseChainHandler.${method} is not implemented yet — see base-chain-handler issue ${issueNumber}.`,
  );
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
  private readonly logger: Logger;

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

    const initialNonce = await client.getTransactionCount({ address: senderAddress, blockTag: 'latest' });

    return new BaseChainHandler({ ...deps, client, senderAddress }, initialNonce);
  }

  /**
   * issue 02: re-reads this Sender's confirmed nonce from the chain and
   * corrects the in-process counter if it's drifted (e.g. a broadcast
   * failed with a nonce-mismatch-shaped RPC error, or this process
   * restarted). Never called on the happy path — `nonceCounter.assignNext`
   * is.
   */
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
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    const sender = requireAddressResult(senderAddress);
    if (!sender.ok) return sender;

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
        // issue 05: `eth_estimateGas` simulates the call and throws if it
        // would revert — but this handler never interprets a Call's
        // semantics, including whether it succeeds (ADR-0018/0027), so a
        // call that would revert is still submitted, exactly like any
        // other. Falls back to a generous fixed gas limit (comfortably
        // under Base's block gas limit) so the real on-chain outcome —
        // success or revert — is what actually gets reported, not a
        // pre-emptive guess made here. By this point `getBlock()` above
        // already proved the RPC itself is reachable, so a failure here
        // is a simulated revert, not a connectivity problem.
        this.logger.warn(
          { error: extractMessage(cause) },
          'estimateGas failed (likely a simulated revert) — falling back to a fixed gas limit so the real on-chain outcome is what gets reported',
        );
        gas = FALLBACK_GAS_LIMIT;
      }

      const encoded: EncodedEvmTransaction = {
        senderAddress: sender.value,
        chainId: this.chainId,
        nonce: this.nonceCounter.assignNext(),
        to: to.value,
        value: call.value,
        data: call.data as EncodedEvmTransaction['data'],
        gas: gas.toString(),
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
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
    const encoded = decodeUnsignedTransaction(prepared.unsignedTransaction);
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

    const tx = toViemTransaction(encoded);
    const unsignedSerialized = serializeTransaction(tx);
    const signingHash = keccak256(unsignedSerialized);

    const signResult = await this.signerClient.requestSignature({
      chain: 'base',
      curve: 'secp256k1',
      address: senderAddress,
      unsignedTxBytes: Buffer.from(signingHash.slice(2), 'hex').toString('base64'),
    });
    if (!signResult.ok) {
      this.logger.warn({ error: signResult.error }, 'signer request failed');
      return signResult;
    }

    const signatureBytes = Buffer.from(signResult.value.signature, 'base64');
    if (signatureBytes.length !== 65) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `signer returned a ${signatureBytes.length}-byte signature, expected 65 (r||s||recovery)`,
      });
    }
    const r = `0x${signatureBytes.subarray(0, 32).toString('hex')}` as const;
    const s = `0x${signatureBytes.subarray(32, 64).toString('hex')}` as const;
    const yParity = signatureBytes[64];

    const signed = serializeTransaction(tx, { r, s, yParity: yParity ?? 0 });
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

    let decoded: ReturnType<typeof parseTransaction>;
    try {
      decoded = parseTransaction(signed as `0x${string}`);
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'not a decodable EIP-1559 signed transaction',
        chainDetail: extractMessage(cause),
      });
    }
    const { nonce, to, gas, maxFeePerGas, maxPriorityFeePerGas } = decoded;
    if (
      decoded.type !== 'eip1559' ||
      decoded.chainId !== this.chainId ||
      nonce === undefined ||
      !to ||
      gas === undefined ||
      maxFeePerGas === undefined ||
      maxPriorityFeePerGas === undefined
    ) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `cannot replace: not a complete EIP-1559 transaction for chain ID ${this.chainId}`,
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

  validateSignedTransaction(_signed: SignedTransaction): Promise<Result<void, DispatchError>> {
    throw notImplemented('validateSignedTransaction', 13);
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
    let nonce: number;
    try {
      const decoded = parseTransaction(signed as `0x${string}`);
      if (decoded.nonce === undefined) {
        return err({ code: 'CHAIN_REJECTED', message: 'signed transaction has no nonce' });
      }
      nonce = decoded.nonce;
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'not a decodable EIP-1559 signed transaction',
        chainDetail: extractMessage(cause),
      });
    }

    let hash: string;
    try {
      hash = await this.client.sendRawTransaction({ serializedTransaction: signed as `0x${string}` });
    } catch (cause) {
      this.logger.warn({ error: extractMessage(cause) }, 'sendRawTransaction failed');
      return err(mapBaseFailure(cause));
    }

    await this.nonceHistoryStore.recordNonce({
      chain: 'base',
      senderAddress: this.senderAddress,
      nonce,
      hash,
    });
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

  /** Test-only — not part of ChainHandler. Exercises issue 02's resync path directly, since no other code calls it yet. */
  testOnlyResyncNonce(): Promise<void> {
    return this.resyncNonce();
  }
}
