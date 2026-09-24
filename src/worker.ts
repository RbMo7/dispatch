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

/**
 * issue 12: claims new work (both dispatch modes) and advances whatever's
 * already broadcast, every tick. A failure here is caught and logged
 * rather than crashing the process — one bad tick (e.g. a transient RPC
 * outage) must not take the whole worker down; the next tick tries again.
 */
async function tick(): Promise<void> {
  try {
    await coordinator.processQueuedDispatches(BATCH_LIMIT);
    await coordinator.processQueuedRelayDispatches(BATCH_LIMIT);
    await coordinator.pollPendingTransactions(BATCH_LIMIT);
  } catch (cause) {
    logger.error({ cause }, 'worker tick failed');
  }
}

let running = true;

function shutdown(signal: string): void {
  logger.info({ signal }, 'worker shutting down');
  running = false;
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info({ chains: [...chainRegistry.handlers.keys()] }, 'worker started');

// A self-scheduling loop, not setInterval: the next tick is only scheduled
// once the current one (and everything it awaited) has actually finished,
// so a slow tick can never overlap with the next one.
while (running) {
  await tick();
  if (!running) break;
  await sleep(POLL_INTERVAL_MS);
}

logger.info('worker stopped');
process.exit(0);
