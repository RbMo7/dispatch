import { approvalLoop as runApprovalLoop } from './approval-loop.js';
import {
  loadAssetRegistry,
  loadChainRegistry,
  coordinatorConfigFor,
  REORG_RECHECK_INTERVAL_MS,
  signerKeysFor,
  workerSignerClient,
} from './chain-loaders.js';
import { Coordinator } from './coordinator/coordinator.js';
import { db } from './db/client.js';
import type { SenderRef } from './domain/sender.js';
import { effectsLoop as runEffectsLoop } from './effects/record-effects.js';
import { logger } from './logger.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';
import { cliContext } from './setup/cli-context.js';
import { CHECKS } from './setup/checks.js';
import { planChecks, runPlanned } from './setup/run.js';
import { setupChecksLoop as runSetupChecksLoop } from './setup-checks-loop.js';
import { signerKeysLoop as runSignerKeysLoop } from './signer-keys-loop.js';

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

const store = new PostgresDispatchStore(db);
const signer = workerSignerClient();
const assets = await loadAssetRegistry(store);
const chainRegistry = await loadChainRegistry(assets, signer);
const { senders, abandonmentTimeoutMs, reorgRecheckWindowMs, stuckHandling } =
  coordinatorConfigFor(chainRegistry);

const coordinator = new Coordinator({
  store,
  chainHandlers: chainRegistry.handlers,
  senders,
  abandonmentTimeoutMs,
  reorgRecheckWindowMs,
  stuckHandling,
});

// ADR-0060: Dispatches from before named Senders get their chain's default
// Sender first, so everything below can tell which Sender's handler owns them.
await coordinator.assignUnassignedDispatches();
// #20 review (ADR-0041): before anything is signed, reserve every nonce the
// engine's in-flight Transactions hold — including one written down but never
// sent before a crash, which recovery will send.
await coordinator.restoreReservations();
await coordinator.reportWorkOnDisabledChains();

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
 * issue 12: claims new Relay Dispatches and advances whatever's already
 * broadcast, every tick. A failure here is caught and logged rather than
 * crashing the process — one bad tick (e.g. a transient RPC outage) must not
 * take the whole worker down; the next tick tries again.
 */
async function mainLoop(): Promise<void> {
  while (running) {
    try {
      await coordinator.processQueuedRelayDispatches(BATCH_LIMIT);
      await coordinator.pollPendingTransactions(BATCH_LIMIT);
    } catch (cause) {
      logger.error({ err: cause }, 'worker tick failed');
    }
    if (!running) break;
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * ADR-0060: claims and sends one Sender's Managed Dispatches, on that
 * Sender's own loop, so a slow send, a full Proposal slot or a Signer refusal
 * on one Sender never delays another Sender's next claim.
 */
async function senderLoop(sender: SenderRef): Promise<void> {
  while (running) {
    try {
      await coordinator.processQueuedDispatchesFor(sender, BATCH_LIMIT);
    } catch (cause) {
      logger.error(
        { err: cause, chain: sender.chain, sender: sender.address },
        'sender tick failed',
      );
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
      logger.error({ err: cause }, 'worker rewatch tick failed');
    }
    if (!running) break;
    await sleep(REWATCH_INTERVAL_MS);
  }
}

/**
 * base-chain-handler issue 07: the reorg safety net's own separate,
 * low-frequency self-scheduling loop — mirrors rewatchLoop's shape
 * exactly, for the same reason (a genuinely different, much slower
 * cadence than the main poll loop).
 */
/**
 * #20 (ADR-0041): resumes claims a crashed worker left half-done — a
 * claim counts as stale after 5 minutes, so checking once a minute is
 * plenty. The same cadence repeats the startup warning about work waiting
 * on a chain that is not enabled (#57), since the API may keep queueing it.
 */
const RECLAIM_INTERVAL_MS = 60_000;

async function reclaimLoop(): Promise<void> {
  while (running) {
    try {
      await coordinator.reclaimStaleClaims(BATCH_LIMIT);
      await coordinator.reportWorkOnDisabledChains();
    } catch (cause) {
      logger.error({ err: cause }, 'worker reclaim tick failed');
    }
    if (!running) break;
    await sleep(RECLAIM_INTERVAL_MS);
  }
}

async function reorgRecheckLoop(): Promise<void> {
  while (running) {
    try {
      await coordinator.recheckRecentlyConfirmedTransactions(BATCH_LIMIT);
    } catch (cause) {
      logger.error({ err: cause }, 'worker reorg-recheck tick failed');
    }
    if (!running) break;
    await sleep(REORG_RECHECK_INTERVAL_MS);
  }
}

/**
 * ADR-0054: watches multisig Proposals (every 10 seconds, each Proposal on its
 * own `next_check_at`). Does nothing for a deployment with no Multisig Sender.
 */
function approvalLoop(): Promise<void> {
  return runApprovalLoop({
    coordinator,
    isRunning: () => running,
    limit: BATCH_LIMIT,
    logger,
    sleep,
  });
}

/** ADR-0059: records each Sender key's pins for `GET /v1/senders`, so the API never calls the Signer. */
function signerKeysLoop(): Promise<void> {
  return runSignerKeysLoop({
    keys: signerKeysFor(chainRegistry),
    readPins: (address) => signer.readPins(address),
    store,
    now: () => new Date(),
    logger,
    isRunning: () => running,
    sleep,
  });
}

/**
 * #137: runs the `worker` setup checks and records them for `GET /v1/setup`.
 * Each run builds its reads afresh, so a read that failed once is tried again
 * on the next run rather than remembered.
 */
function setupChecksLoop(): Promise<void> {
  return runSetupChecksLoop({
    runChecks: async () => {
      const { context, close } = cliContext(process.env);
      try {
        return await runPlanned(planChecks(CHECKS, context, { place: 'worker' }));
      } finally {
        await close().catch(() => {});
      }
    },
    store,
    now: () => new Date(),
    logger,
    isRunning: () => running,
    sleep,
  });
}

/** ADR-0063: reads each confirmed transaction's effects once, for item reads to decode. */
function effectsLoop(): Promise<void> {
  return runEffectsLoop({
    store,
    handlers: chainRegistry.handlers,
    limit: BATCH_LIMIT,
    now: () => new Date(),
    logger,
    isRunning: () => running,
    sleep,
  });
}

logger.info(
  {
    chains: [...chainRegistry.handlers.keys()],
    senders: chainRegistry.senders.map(
      (s) => `${s.chain}:${s.name}${s.isDefault ? ' (default)' : ''}`,
    ),
  },
  'worker started',
);

// All of these are self-scheduling loops, not setInterval: each only
// schedules its own next tick once its current one (and everything it
// awaited) has actually finished, so a slow tick can never overlap the
// next one — and the loops run fully independently of each other.
await Promise.all([
  ...coordinator.senders.map((sender) => senderLoop(sender.ref)),
  mainLoop(),
  rewatchLoop(),
  reorgRecheckLoop(),
  reclaimLoop(),
  approvalLoop(),
  signerKeysLoop(),
  setupChecksLoop(),
  effectsLoop(),
]);

logger.info('worker stopped');
process.exit(0);
