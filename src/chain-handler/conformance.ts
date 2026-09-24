import { describe, expect, it } from 'vitest';

import type { CallForChain, Payment } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { ChainHandler, SignedTransaction } from './chain-handler.js';

export type ChainHandlerConformanceFixtures<C extends Chain> = {
  senderAddress: string;
  /** An asset identifier `getBalance` can be queried with (native or token, chain-specific). */
  asset: string;
  /** A structurally valid Payment `paymentToCall` can translate. */
  validPayment: Payment;
  /** A structurally valid Call this suite can prepare/validate against. */
  validCall: CallForChain<C>;
  /** A Call `validateCall` is expected to reject (e.g. a malformed recipient). */
  invalidCall: CallForChain<C>;
  /** A SignedTransaction `validateSignedTransaction` is expected to accept — a genuinely, correctly signed transaction. */
  validSignedTransaction: SignedTransaction;
  /**
   * A SignedTransaction `broadcast` is expected to reject with a structured
   * error, not a thrown exception. Free to be an implementation-specific
   * sentinel a handler special-cases for testing (as the stub's
   * `'force-failure'` does) rather than a realistic malformed payload — all
   * this fixture needs to guarantee is that `broadcast` treats it as a
   * failure.
   */
  invalidSignedTransaction: SignedTransaction;
};

/**
 * The extendibility contract (ADR-0015): behavioral tests written against
 * ChainHandler only, exported so the same suite runs against every
 * implementation — current and future. A new Chain Handler is trusted by
 * passing this, without a maintainer re-auditing its internals by hand.
 *
 * Call this at the top level of a `*.test.ts` file — it registers real
 * `describe`/`it` blocks via vitest, exactly as if they'd been written
 * directly in that file.
 */
export function runChainHandlerConformanceSuite<C extends Chain>(
  name: string,
  createHandler: () => ChainHandler<C>,
  fixtures: ChainHandlerConformanceFixtures<C>,
): void {
  describe(`ChainHandler conformance: ${name}`, () => {
    it('paymentToCall translates a valid Payment into a Call validateCall accepts, without mutating the Payment', async () => {
      const handler = createHandler();
      const before = structuredClone(fixtures.validPayment);

      const result = await handler.paymentToCall(fixtures.validPayment);

      expect(fixtures.validPayment).toEqual(before);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const validation = await handler.validateCall(result.value);
      expect(validation.ok).toBe(true);
    });

    it('validateCall rejects a malformed call', async () => {
      const handler = createHandler();
      const result = await handler.validateCall(fixtures.invalidCall);
      expect(result.ok).toBe(false);
    });

    it('validateCall accepts a well-formed call', async () => {
      const handler = createHandler();
      const result = await handler.validateCall(fixtures.validCall);
      expect(result.ok).toBe(true);
    });

    it('validateCall never mutates the call it is given', async () => {
      const handler = createHandler();
      const before = structuredClone(fixtures.validCall);
      await handler.validateCall(fixtures.validCall);
      expect(fixtures.validCall).toEqual(before);
    });

    it('prepare returns one PreparedTransaction per input Call, in order, without mutating the array it was given', async () => {
      const handler = createHandler();
      const items = [fixtures.validCall, fixtures.validCall];
      const before = structuredClone(items);

      const result = await handler.prepare(items, fixtures.senderAddress);

      expect(items).toEqual(before);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.map((prepared) => prepared.callIndex)).toEqual([0, 1]);
    });

    it('sign succeeds for a validly prepared transaction, without mutating it', async () => {
      const handler = createHandler();
      const prepareResult = await handler.prepare([fixtures.validCall], fixtures.senderAddress);
      expect(prepareResult.ok).toBe(true);
      if (!prepareResult.ok) return;

      const prepared = prepareResult.value[0];
      if (!prepared)
        throw new Error('prepare returned no PreparedTransaction for a single input Call');
      const before = structuredClone(prepared);

      const signResult = await handler.sign(prepared, fixtures.senderAddress);

      expect(prepared).toEqual(before);
      expect(signResult.ok).toBe(true);
    });

    it('getStatus never reports CONFIRMED for a transaction that was never broadcast', async () => {
      const handler = createHandler();
      const result = await handler.getStatus('conformance-suite-never-broadcast');
      expect(result.ok && result.value).not.toBe('CONFIRMED');
    });

    it('validateSignedTransaction accepts a genuinely, correctly signed transaction', async () => {
      const handler = createHandler();
      const result = await handler.validateSignedTransaction(fixtures.validSignedTransaction);
      expect(result.ok).toBe(true);
    });

    it('validateSignedTransaction rejects a malformed signed transaction with a structured error, never throwing', async () => {
      const handler = createHandler();
      const result = await handler.validateSignedTransaction(fixtures.invalidSignedTransaction);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toEqual(expect.any(String));
    });

    it('validateSignedTransaction never mutates the bytes it is given', async () => {
      const handler = createHandler();
      const before = fixtures.validSignedTransaction;
      await handler.validateSignedTransaction(fixtures.validSignedTransaction);
      expect(fixtures.validSignedTransaction).toBe(before);
    });

    it('a broadcast failure surfaces a structured DispatchError instead of throwing', async () => {
      const handler = createHandler();
      const result = await handler.broadcast(fixtures.invalidSignedTransaction);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toEqual(expect.any(String));
    });

    it('getBalance answers for the asset it was asked about, not a different one', async () => {
      const handler = createHandler();
      const result = await handler.getBalance(fixtures.senderAddress, fixtures.asset);
      expect(result.ok).toBe(true);
      expect(result.ok && result.value.asset).toBe(fixtures.asset);
    });
  });
}
