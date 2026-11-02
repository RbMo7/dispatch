import type { Logger } from 'pino';

/** The channel a trigger on `known_assets` notifies on every write (migration 0023). */
export const KNOWN_ASSETS_CHANNEL = 'known_assets';

/** The channel a trigger on `known_contracts` notifies on every write (migration 0028). */
export const KNOWN_CONTRACTS_CHANNEL = 'known_contracts';

/** How often a registry rereads when it cannot listen. */
export const REGISTRY_POLL_MS = 2_000;

/**
 * Subscribes to the channel: `onChange` runs on every notification and every
 * time the subscription is (re)established, since a notification sent while
 * disconnected is lost.
 */
export type ListenForChanges = (onChange: () => void) => Promise<{ unlisten: () => Promise<void> }>;

/**
 * ADR-0061, ADR-0063: keeps a registry (`what`: known assets, known contracts)
 * in step with its table in this process, through Postgres LISTEN/NOTIFY, or a
 * short poll when listening fails. Returns how to stop.
 */
export async function watchRegistry(
  registry: { refresh(): Promise<void> },
  options: { what: string; listen: ListenForChanges; pollMs?: number; logger: Logger },
): Promise<() => Promise<void>> {
  const { what } = options;
  const refresh = () => {
    registry.refresh().catch((cause: unknown) => {
      options.logger.warn({ err: cause }, `${what}: reread failed; keeping the last one`);
    });
  };
  try {
    const { unlisten } = await options.listen(refresh);
    return unlisten;
  } catch (cause) {
    const pollMs = options.pollMs ?? REGISTRY_POLL_MS;
    options.logger.warn(
      { err: cause, pollMs },
      `${what}: cannot listen for changes; rereading on a timer instead`,
    );
    const timer = setInterval(refresh, pollMs);
    timer.unref();
    return () => {
      clearInterval(timer);
      return Promise.resolve();
    };
  }
}
