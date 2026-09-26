import type { ChainHandler } from '../chain-handler/chain-handler.js';
import type { Chain } from '../domain/chain.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

const KNOWN_CHAINS: readonly Chain[] = ['base', 'solana'];

function isChain(value: string): value is Chain {
  return (KNOWN_CHAINS as readonly string[]).includes(value);
}

/**
 * Parses the `ENABLED_CHAINS` config value (a comma-separated list, e.g.
 * `solana,evm`, ADR-0019) into validated Chain names. Throws on an unknown
 * name — a misconfigured operator env var is a startup-time configuration
 * bug, not a business-relevant outcome (ADR-0010).
 */
export function parseEnabledChains(raw: string): Chain[] {
  return raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      if (!isChain(name)) {
        throw new Error(
          `ENABLED_CHAINS names an unknown chain: "${name}" — must be one of ${KNOWN_CHAINS.join(', ')}.`,
        );
      }
      return name;
    });
}

/** Dynamically imports and constructs the Chain Handler for one chain — only ever called for a chain that's actually enabled. */
export type ChainHandlerLoader = () => Promise<ChainHandler>;

/**
 * Chain Handlers are activated by config, not by code (ADR-0019): only the
 * chains named in `ENABLED_CHAINS` are ever imported, so a disabled chain's
 * module is never loaded, never opens an RPC connection, never starts a
 * confirmation-polling loop. A chain named in `ENABLED_CHAINS` that this
 * build has no loader for is a configuration bug (throws at `load()`); a
 * chain that was simply never enabled answers `CHAIN_NOT_ENABLED`
 * (ADR-0010) from `get()`, never a crash.
 */
export class ChainRegistry {
  /** The registered handlers — already the exact shape the Coordinator (issue 06) takes as `chainHandlers`. */
  readonly handlers: ReadonlyMap<Chain, ChainHandler>;

  private constructor(handlers: ReadonlyMap<Chain, ChainHandler>) {
    this.handlers = handlers;
  }

  /**
   * Builds a registry from the operator's enabled chains and the full set
   * of loaders this build knows how to construct — importing (and so
   * running the constructor of) only the ones actually enabled.
   */
  static async load(
    enabledChains: readonly Chain[],
    loaders: Partial<Record<Chain, ChainHandlerLoader>>,
  ): Promise<ChainRegistry> {
    const handlers = new Map<Chain, ChainHandler>();

    for (const chain of enabledChains) {
      const loader = loaders[chain];
      if (!loader) {
        throw new Error(
          `ENABLED_CHAINS names "${chain}" but this build has no Chain Handler loader registered for it.`,
        );
      }
      handlers.set(chain, await loader());
    }

    return new ChainRegistry(handlers);
  }

  isEnabled(chain: Chain): boolean {
    return this.handlers.has(chain);
  }

  get(chain: Chain): Result<ChainHandler, DispatchError> {
    const handler = this.handlers.get(chain);
    if (!handler) {
      return err({ code: 'CHAIN_NOT_ENABLED', message: `chain not enabled: ${chain}` });
    }
    return ok(handler);
  }
}
