import { loadChainRegistry, coordinatorConfigFor } from './chain-loaders.js';
import { Coordinator } from './coordinator/coordinator.js';
import { db } from './db/client.js';
import { logger } from './logger.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';

/**
 * How many queued/pending rows one tick claims or checks — a bounded batch
 * per ADR-0009's outbox pattern, never "everything at once."
 */
const BATCH_LIMIT = 20;
/** How long to wait after a tick before the next one. */
const POLL_INTERVAL_MS = 2_000;
/**
 * issue 10: the ABANDONED re-watch's own, deliberately much slower cadence
 * — "low frequency" (ADR-0004/CONTEXT.md) relative to the main poll loop
 * above. A separate interval, not a modulo counter on the main loop's own
 * tick count, so the two cadences stay independently tunable and neither
 * loop needs to know the other exists.
 */
const REWATCH_INTERVAL_MS = 5 * 60_000;
/**
 * issue 15: last-resort guard. Every outbound RPC/Signer call now carries
 * its own deadline (rpc-timeout.ts), so an in-flight tick should always
 * unwind well before this fires — this exists only in case some future
 * call path is added without going through that shared timeout.
 */
const SHUTDOWN_FORCE_EXIT_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const chainRegistry = await loadChainRegistry();
const { senderAddresses, abandonmentTimeoutMs } = coordinatorConfigFor(chainRegistry);

const coordinator = new Coordinator({
  store: new PostgresDispatchStore(db),
  chainHandlers: chainRegistry.handlers,
  senderAddresses,
  abandonmentTimeoutMs,
});

let running = true;

function shutdown(signal: string): void {
  logger.info({ signal }, 'worker shutting down');
  running = false;
  setTimeout(() => {
    logger.error(
      { signal, timeoutMs: SHUTDOWN_FORCE_EXIT_MS },
      'graceful shutdown timed out, forcing exit',
    );
    process.exit(1);
  }, SHUTDOWN_FORCE_EXIT_MS);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * issue 12: claims new work (both dispatch modes) and advances whatever's
 * already broadcast, every tick. A failure here is caught and logged
 * rather than crashing the process — one bad tick (e.g. a transient RPC
 * outage) must not take the whole worker down; the next tick tries again.
 */
async function mainLoop(): Promise<void> {
  while (running) {
    try {
      await coordinator.processQueuedDispatches(BATCH_LIMIT);
      await coordinator.processQueuedRelayDispatches(BATCH_LIMIT);
      await coordinator.pollPendingTransactions(BATCH_LIMIT);
    } catch (cause) {
      logger.error({ cause }, 'worker tick failed');
    }
    if (!running) break;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * issue 10: the ABANDONED re-watch, on its own separate, much slower
 * cadence — a wholly separate self-scheduling loop, not a branch inside
 * mainLoop, so "low frequency" is simply "how rarely this loop's own
 * sleep lets it run" rather than any state either loop has to track.
 */
async function rewatchLoop(): Promise<void> {
  while (running) {
    try {
      await coordinator.rewatchAbandonedTransactions(BATCH_LIMIT);
    } catch (cause) {
      logger.error({ cause }, 'worker rewatch tick failed');
    }
    if (!running) break;
    await sleep(REWATCH_INTERVAL_MS);
  }
}

logger.info({ chains: [...chainRegistry.handlers.keys()] }, 'worker started');

// Both are self-scheduling loops, not setInterval: each only schedules its
// own next tick once its current one (and everything it awaited) has
// actually finished, so a slow tick can never overlap the next one — and
// the two loops run fully independently of each other.
await Promise.all([mainLoop(), rewatchLoop()]);

logger.info('worker stopped');
process.exit(0);
