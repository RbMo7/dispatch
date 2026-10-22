import type { Logger } from 'pino';

/** ADR-0054: how long the worker waits between two looks at the Proposals that are due (each has its own `next_check_at`). */
export const APPROVAL_TICK_MS = 10_000;

/**
 * The worker's approval loop, a self-scheduling loop like the others: each
 * tick asks the Coordinator to watch the Proposals that are due. A failed
 * tick is logged and the loop carries on; the next tick tries again.
 */
export async function approvalLoop(deps: {
  coordinator: { watchProposals(limit: number): Promise<void> };
  isRunning: () => boolean;
  limit: number;
  logger: Logger;
  sleep: (ms: number) => Promise<void>;
  tickMs?: number;
}): Promise<void> {
  while (deps.isRunning()) {
    try {
      await deps.coordinator.watchProposals(deps.limit);
    } catch (cause) {
      deps.logger.error({ err: cause }, 'worker approval tick failed');
    }
    if (!deps.isRunning()) break;
    await deps.sleep(deps.tickMs ?? APPROVAL_TICK_MS);
  }
}
