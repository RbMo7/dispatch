import type { Logger } from 'pino';

import type { ChainHandler } from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

/** How often the worker looks for confirmed transactions without effects. */
export const EFFECTS_TICK_MS = 5_000;

export type RecordEffectsDeps = {
  store: Pick<
    DispatchStore,
    'listTransactionsAwaitingEffects' | 'recordEffects' | 'recordEffectsReadFailure'
  >;
  /** One handler per enabled chain; a chain whose handler cannot read effects is skipped. */
  handlers: ReadonlyMap<Chain, Pick<ChainHandler, 'readEffects'>>;
  limit: number;
  now: () => Date;
  logger: Logger;
};

/**
 * ADR-0063: reads each confirmed transaction that has no stored effects yet,
 * once. Safe to run any number of times, and after a crash at any point: a
 * transaction is due only while its effects are missing, and storing them a
 * second time keeps the first.
 */
export async function recordEffects(deps: RecordEffectsDeps): Promise<void> {
  const chains = [...deps.handlers].flatMap(([chain, handler]) =>
    handler.readEffects ? [chain] : [],
  );
  if (chains.length === 0) return;
  for (const ref of await deps.store.listTransactionsAwaitingEffects(
    chains,
    deps.now(),
    deps.limit,
  )) {
    const read = await deps.handlers.get(ref.chain)!.readEffects!(ref.hash);
    if (read.ok) {
      await deps.store.recordEffects(ref, read.value, deps.now());
    } else {
      deps.logger.warn({ ...ref, error: read.error }, 'reading transaction effects failed');
      await deps.store.recordEffectsReadFailure(ref, read.error.message, deps.now());
    }
  }
}

export async function effectsLoop(
  deps: RecordEffectsDeps & { isRunning: () => boolean; sleep: (ms: number) => Promise<void> },
): Promise<void> {
  while (deps.isRunning()) {
    try {
      await recordEffects(deps);
    } catch (cause) {
      deps.logger.error({ err: cause }, 'worker effects tick failed');
    }
    if (!deps.isRunning()) break;
    await deps.sleep(EFFECTS_TICK_MS);
  }
}
