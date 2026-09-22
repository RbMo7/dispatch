import { describe, expect, it } from 'vitest';

import type { CallForChain } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { ChainHandler, SignedTransaction } from './chain-handler.js';

export type ChainHandlerConformanceFixtures<C extends Chain> = {
  senderAddress: string;
  /** A structurally valid Call this suite can prepare/validate against. */
  validCall: CallForChain<C>;
  /** A Call `validateCall` is expected to reject (e.g. a malformed recipient). */
  invalidCall: CallForChain<C>;
  /** A SignedTransaction `broadcast` is expected to reject with a structured error, not a thrown exception. */
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

    it('getStatus never reports CONFIRMED for a transaction that was never broadcast', async () => {
      const handler = createHandler();
      const result = await handler.getStatus('conformance-suite-never-broadcast');
      expect(result.ok && result.value).not.toBe('CONFIRMED');
    });

    it('a broadcast failure surfaces a structured DispatchError instead of throwing', async () => {
      const handler = createHandler();
      const result = await handler.broadcast(fixtures.invalidSignedTransaction);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error.code).toEqual(expect.any(String));
    });
  });
}
