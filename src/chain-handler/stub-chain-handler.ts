import type { EvmCall, Payment } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import type {
  Balance,
  BroadcastResult,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  SignedTransaction,
} from './chain-handler.js';

/**
 * A trivial, no-op `ChainHandler<'evm'>` that never touches a real chain —
 * it exists solely to prove the conformance suite itself runs and catches
 * what it's supposed to (issue 05: mutated input, a swallowed error,
 * premature CONFIRMED). It is not evidence a real Chain Handler behaves
 * correctly; that's solana-chain-handler's own conformance run, under
 * ADR-0013's real-RPC discipline. `evm` is an arbitrary choice here — this
 * stub asserts nothing about EVM's actual transaction shape.
 */
export class StubChainHandler implements ChainHandler<'evm'> {
  readonly chain = 'evm';

  private readonly broadcastHashes = new Set<string>();
  private nextHash = 0;

  /**
   * A real ChainHandler.paymentToCall does a real native/token-transfer
   * encoding (ADR-0028) — this stub just wraps the Payment's own fields
   * into a well-formed-looking EvmCall, only so validateCall and the
   * conformance suite have something to exercise.
   */
  paymentToCall(payment: Payment): Promise<Result<EvmCall, DispatchError>> {
    if (!payment.recipient.startsWith('0x')) {
      return Promise.resolve(
        err({
          code: 'INVALID_RECIPIENT',
          message: `not a well-formed address: ${payment.recipient}`,
        }),
      );
    }
    return Promise.resolve(ok({ to: payment.recipient, data: '0x', value: payment.amount }));
  }

  validateCall(call: EvmCall): Promise<Result<void, DispatchError>> {
    if (!call.to.startsWith('0x')) {
      return Promise.resolve(
        err({ code: 'INVALID_RECIPIENT', message: `not a well-formed address: ${call.to}` }),
      );
    }
    return Promise.resolve(ok(undefined));
  }

  prepare(
    items: EvmCall[],
    _senderAddress: string,
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    const prepared = items.map((item, callIndex) => ({
      callIndex,
      unsignedTransaction: JSON.stringify(item),
    }));
    return Promise.resolve(ok(prepared));
  }

  /**
   * A real ChainHandler.sign delegates to an injected SignerClient
   * (ADR-0002) — this stub has no Signer at all and fabricates a signature
   * inline, since the conformance suite only checks that `sign` doesn't
   * mutate its input and succeeds, never how a signature is produced.
   */
  sign(
    prepared: PreparedTransaction,
    _senderAddress: string,
  ): Promise<Result<SignedTransaction, DispatchError>> {
    return Promise.resolve(ok(`${prepared.unsignedTransaction}:stub-signature`));
  }

  validateSignedTransaction(signed: SignedTransaction): Promise<Result<void, DispatchError>> {
    if (signed === 'force-failure') {
      return Promise.resolve(
        err({
          code: 'CHAIN_REJECTED',
          message: 'stub forced this signed transaction to be invalid',
        }),
      );
    }
    return Promise.resolve(ok(undefined));
  }

  broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> {
    if (signed === 'force-failure') {
      return Promise.resolve(
        err({ code: 'CHAIN_REJECTED', message: 'stub forced this broadcast to fail' }),
      );
    }

    const hash = `stub-hash-${this.nextHash++}`;
    this.broadcastHashes.add(hash);
    return Promise.resolve(ok({ hash }));
  }

  getStatus(hash: string): Promise<Result<ChainStatus, DispatchError>> {
    const status: ChainStatus = this.broadcastHashes.has(hash) ? 'CONFIRMED' : 'PENDING';
    return Promise.resolve(ok(status));
  }

  getBalance(_address: string, asset: string): Promise<Result<Balance, DispatchError>> {
    return Promise.resolve(ok({ asset, amount: '0' }));
  }
}
