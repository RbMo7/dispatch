import type { Logger } from 'pino';

import type { AssetRegistry } from './asset-registry.js';

/** The channel a trigger on `known_assets` notifies on every write (migration 0023). */
export const KNOWN_ASSETS_CHANNEL = 'known_assets';

/** How often a registry rereads when it cannot listen. */
export const KNOWN_ASSETS_POLL_MS = 2_000;

/**
 * Subscribes to the channel: `onChange` runs on every notification and every
 * time the subscription is (re)established, since a notification sent while
 * disconnected is lost.
 */
export type ListenForChanges = (onChange: () => void) => Promise<{ unlisten: () => Promise<void> }>;

/**
 * ADR-0061: keeps `registry` in step with `known_assets` in this process,
 * through Postgres LISTEN/NOTIFY, or a short poll when listening fails.
 * Returns how to stop.
 */
export async function watchKnownAssets(
  registry: AssetRegistry,
  options: { listen: ListenForChanges; pollMs?: number; logger: Logger },
): Promise<() => Promise<void>> {
  const refresh = () => {
    registry.refresh().catch((cause: unknown) => {
      options.logger.warn({ err: cause }, 'known assets: reread failed; keeping the last one');
    });
  };
  try {
    const { unlisten } = await options.listen(refresh);
    return unlisten;
  } catch (cause) {
    const pollMs = options.pollMs ?? KNOWN_ASSETS_POLL_MS;
    options.logger.warn(
      { err: cause, pollMs },
      'known assets: cannot listen for changes; rereading on a timer instead',
    );
    const timer = setInterval(refresh, pollMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      return Promise.resolve();
    };
  }
}
