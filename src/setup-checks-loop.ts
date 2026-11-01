import type { Logger } from 'pino';

import type { DispatchStore } from './repository/dispatch-store.js';
import type { CheckOutcome } from './setup/run.js';

/** #137: how often the worker runs its setup checks; the console's Setup page can lag by this much. */
export const SETUP_CHECKS_TICK_MS = 5 * 60_000;

export type SetupCheckRunDeps = {
  /** Every `worker` check, each bounded by its own timeout, so a run always finishes. */
  runChecks: () => Promise<CheckOutcome[]>;
  store: Pick<DispatchStore, 'recordSetupChecks'>;
  now: () => Date;
  logger: Logger;
};

export async function recordSetupChecks(deps: SetupCheckRunDeps): Promise<void> {
  const outcomes = await deps.runChecks();
  const ranAt = deps.now();
  const failing = outcomes.filter((outcome) => outcome.result.status !== 'pass');
  if (failing.length > 0) {
    deps.logger.warn(
      { checks: failing.map(({ id, result }) => ({ id, status: result.status })) },
      'setup checks need attention',
    );
  }
  await deps.store.recordSetupChecks(outcomes.map((outcome) => ({ ...outcome, ranAt })));
}

/** A failing check never stops the worker: it is recorded for the console and the loop runs on. */
export async function setupChecksLoop(
  deps: SetupCheckRunDeps & {
    isRunning: () => boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<void> {
  while (deps.isRunning()) {
    try {
      await recordSetupChecks(deps);
    } catch (cause) {
      deps.logger.error({ err: cause }, 'worker setup-checks tick failed');
    }
    if (!deps.isRunning()) break;
    await deps.sleep(SETUP_CHECKS_TICK_MS);
  }
}
