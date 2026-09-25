import { createPublicClient, http, isAddress, type Address, type PublicClient } from 'viem';
import type { Logger } from 'pino';

import type { CallForChain, EvmCall, Payment } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import type { Result } from '../../domain/result.js';
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
import type { BaseTokenRegistry } from './known-tokens.js';
import { NonceCounter } from './nonce-authority.js';

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

function requireAddress(value: string): Address {
  if (!isAddress(value)) {
    throw new Error(`not a well-formed EVM address: ${value}`);
  }
  return value;
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

  paymentToCall(_payment: Payment): Promise<Result<CallForChain<'base'>, DispatchError>> {
    throw notImplemented('paymentToCall', 3);
  }

  validateCall(_call: EvmCall): Promise<Result<void, DispatchError>> {
    throw notImplemented('validateCall', 3);
  }

  prepare(
    _items: EvmCall[],
    _senderAddress: string,
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    throw notImplemented('prepare', 3);
  }

  sign(
    _prepared: PreparedTransaction,
    _senderAddress: string,
  ): Promise<Result<SignedTransaction, DispatchError>> {
    throw notImplemented('sign', 3);
  }

  validateSignedTransaction(_signed: SignedTransaction): Promise<Result<void, DispatchError>> {
    throw notImplemented('validateSignedTransaction', 13);
  }

  broadcast(_signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> {
    throw notImplemented('broadcast', 3);
  }

  getStatus(_hash: string): Promise<Result<ChainStatus, DispatchError>> {
    throw notImplemented('getStatus', 6);
  }

  getBalance(_address: string, _asset: string): Promise<Result<Balance, DispatchError>> {
    throw notImplemented('getBalance', 3);
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
