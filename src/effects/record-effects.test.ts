import pino from 'pino';
import { describe, expect, it } from 'vitest';

import { CHAINS } from '../domain/chain.js';
import { EFFECTS_READ, type TransactionEffects } from '../domain/effects.js';
import { err, ok } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { recordEffects } from './record-effects.js';
import { readRecorded } from './test-support/recorded.js';

const logger = pino({ level: 'silent' });

async function confirmedBundle(store: InMemoryDispatchStore, hash: string) {
  const dispatch = await store.createDispatch({
    chain: 'solana',
    idempotencyKey: hash,
    items: [0, 1].map(() => ({
      call: { programId: 'prog', accounts: [], data: '' },
      payment: { recipient: 'r', asset: 'SOL', amount: '1' },
    })),
    retryPolicy: false,
  });
  await store.claimQueued(CHAINS, 10);
  const rows = await store.createTransactions(
    [0, 1].map((callIndex) => ({
      dispatchId: dispatch.id,
      callIndex,
      chain: 'solana' as const,
      signedBytes: 's',
      hash,
    })),
  );
  for (const row of rows) await store.markConfirmed(row.id);
}

describe('recordEffects (ADR-0063)', () => {
  it('reads a confirmed transaction once, however often it runs, for every Call it carries', async () => {
    const store = new InMemoryDispatchStore();
    const effects = await readRecorded('solana-relay');
    await confirmedBundle(store, 'sig-confirmed');
    const reads: string[] = [];
    const deps = {
      store,
      handlers: new Map([
        [
          'solana' as const,
          {
            readEffects: (hash: string) => {
              reads.push(hash);
              return Promise.resolve(ok<TransactionEffects>(effects));
            },
          },
        ],
      ]),
      limit: 10,
      now: () => new Date(),
      logger,
    };

    await recordEffects(deps);
    await recordEffects(deps);

    expect(reads).toEqual(['sig-confirmed']);
    expect((await store.listEffects('solana', ['sig-confirmed'])).get('sig-confirmed')).toEqual(
      effects,
    );
  });

  it('tries a failed read again once its wait is over', async () => {
    const store = new InMemoryDispatchStore();
    const effects = await readRecorded('solana-relay');
    await confirmedBundle(store, 'sig-flaky');
    let now = new Date();
    let calls = 0;
    const deps = {
      store,
      handlers: new Map([
        [
          'solana' as const,
          {
            readEffects: () =>
              Promise.resolve(
                ++calls === 1
                  ? err({ code: 'RPC_UNAVAILABLE' as const, message: 'timed out' })
                  : ok<TransactionEffects>(effects),
              ),
          },
        ],
      ]),
      limit: 10,
      now: () => now,
      logger,
    };

    await recordEffects(deps);
    await recordEffects(deps);
    expect(calls).toBe(1);
    expect(await store.listEffects('solana', ['sig-flaky'])).toEqual(new Map());

    now = new Date(now.getTime() + EFFECTS_READ.retryAfterMs);
    await recordEffects(deps);
    expect(calls).toBe(2);
    expect((await store.listEffects('solana', ['sig-flaky'])).get('sig-flaky')).toEqual(effects);
  });
});
