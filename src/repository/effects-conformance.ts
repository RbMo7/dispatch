import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import { EFFECTS_READ, type SolanaEffects } from '../domain/effects.js';
import type { DispatchStore } from './dispatch-store.js';

const item: DispatchItem<'solana'> = {
  call: { programId: 'prog', accounts: [], data: '' },
  payment: { recipient: 'r', asset: 'SOL', amount: '1' },
};

const effects = (fee: string): SolanaEffects => ({
  chain: 'solana',
  slot: 1,
  feePayer: 'payer',
  fee,
  instructions: [],
  lamports: [],
  tokenBalances: [],
  logMessages: [],
  truncated: false,
});

/** One Dispatch of `calls` Calls bundled into one transaction under `hash`, in `status`. */
async function bundled(store: DispatchStore, hash: string, calls: number, confirm: boolean) {
  const dispatch = await store.createDispatch({
    chain: 'solana',
    idempotencyKey: randomUUID(),
    items: Array.from({ length: calls }, () => item),
    retryPolicy: false,
  });
  await store.claimQueued(CHAINS, 10);
  const rows = await store.createTransactions(
    Array.from({ length: calls }, (_, callIndex) => ({
      dispatchId: dispatch.id,
      callIndex,
      chain: 'solana' as const,
      signedBytes: 's',
      hash,
    })),
  );
  if (confirm) for (const row of rows) await store.markConfirmed(row.id);
  return rows;
}

export function runEffectsConformanceSuite(makeStore: () => DispatchStore): void {
  describe('transaction effects (ADR-0063)', () => {
    const later = (ms: number) => new Date(Date.now() + ms);

    it('asks for each confirmed transaction once, however many Calls share it, and never for one still pending', async () => {
      const store = makeStore();
      const hash = `sig-${randomUUID()}`;
      await bundled(store, hash, 2, true);
      await bundled(store, `pending-${randomUUID()}`, 1, false);

      const due = await store.listTransactionsAwaitingEffects(CHAINS, later(1_000), 100);
      expect(due.filter((ref) => ref.hash === hash)).toEqual([{ chain: 'solana', hash }]);
      expect(due.some((ref) => ref.hash.startsWith('pending-'))).toBe(false);
      const onBase = await store.listTransactionsAwaitingEffects(['base'], later(1_000), 100);
      expect(onBase.some((ref) => ref.hash === hash)).toBe(false);
    });

    it('stores effects once: a second read and a later failure leave the first in place', async () => {
      const store = makeStore();
      const hash = `sig-${randomUUID()}`;
      await bundled(store, hash, 1, true);
      const ref = { chain: 'solana' as const, hash };

      await store.recordEffects(ref, effects('5000'), new Date());
      await store.recordEffects(ref, effects('9999'), new Date());
      await store.recordEffectsReadFailure(ref, 'down', new Date());

      expect(await store.listEffects('solana', [hash, 'unknown'])).toEqual(
        new Map([[hash, effects('5000')]]),
      );
      const due = await store.listTransactionsAwaitingEffects(CHAINS, later(1_000), 100);
      expect(due.some((r) => r.hash === hash)).toBe(false);
    });

    it('waits longer after each failed read, and gives up after the last', async () => {
      const store = makeStore();
      const hash = `sig-${randomUUID()}`;
      await bundled(store, hash, 1, true);
      const ref = { chain: 'solana' as const, hash };
      const isDue = async (at: Date) =>
        (await store.listTransactionsAwaitingEffects(CHAINS, at, 100)).some((r) => r.hash === hash);

      const failedAt = new Date();
      await store.recordEffectsReadFailure(ref, 'down', failedAt);
      expect(await isDue(new Date(failedAt.getTime() + EFFECTS_READ.retryAfterMs - 1))).toBe(false);
      expect(await isDue(new Date(failedAt.getTime() + EFFECTS_READ.retryAfterMs))).toBe(true);

      for (let n = 2; n <= EFFECTS_READ.maxFailures; n++) {
        await store.recordEffectsReadFailure(ref, 'down', failedAt);
      }
      expect(await isDue(later(EFFECTS_READ.windowMs / 2))).toBe(false);

      await store.recordEffects(ref, effects('5000'), new Date());
      expect((await store.listEffects('solana', [hash])).get(hash)).toEqual(effects('5000'));
    });

    it('leaves a transaction confirmed before the read window', async () => {
      const store = makeStore();
      const hash = `sig-${randomUUID()}`;
      await bundled(store, hash, 1, true);

      const due = await store.listTransactionsAwaitingEffects(
        CHAINS,
        later(EFFECTS_READ.windowMs + 60_000),
        100,
      );
      expect(due.some((r) => r.hash === hash)).toBe(false);
    });
  });
}
