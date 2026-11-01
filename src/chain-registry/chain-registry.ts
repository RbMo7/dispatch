import type { ChainHandler } from '../chain-handler/chain-handler.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { DEFAULT_SENDER_NAME, type SenderAddress, type SenderName } from '../domain/sender.js';

function isChain(value: string): value is Chain {
  return (CHAINS as readonly string[]).includes(value);
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
          `ENABLED_CHAINS names an unknown chain: "${name}" — must be one of ${CHAINS.join(', ')}.`,
        );
      }
      return name;
    });
}

/** Dynamically imports and constructs the Chain Handler for one chain — only ever called for a chain that's actually enabled. */
export type ChainHandlerLoader = () => Promise<ChainHandler>;

/**
 * ADR-0060: one Sender and the handler that executes for it. Each Sender has
 * its own handler instance (sharing its chain's RPC client), so everything a
 * handler keeps per Sender (Base's nonce counter, Solana's blockhash records,
 * a Multisig Sender's approval capability) is never shared between Senders.
 */
export type RegisteredSender = {
  chain: Chain;
  name: SenderName;
  /**
   * What pays. Null only in a registry built from bare handlers
   * (`ChainRegistry.load`), which knows no address: a Dispatch is then stored
   * with no Sender, and its chain's default Sender takes it over.
   */
  address: SenderAddress | null;
  /** Pays for every Dispatch on its chain that names no Sender. At most one per chain. */
  isDefault: boolean;
  handler: ChainHandler;
  /** A Multisig Sender's multisig: the Squads multisig account, or the Safe (then the same as `address`). */
  multisig?: { address: string; approvalDeadlineMs: number; approvalRewatchWindowMs: number };
};

/**
 * Chain Handlers are activated by config, not by code (ADR-0019): only the
 * chains named in `ENABLED_CHAINS` are ever imported, so a disabled chain's
 * module is never loaded, never opens an RPC connection, never starts a
 * confirmation-polling loop. A chain named in `ENABLED_CHAINS` that this
 * build has no loader for is a configuration bug (throws at `load()`); a
 * chain that was simply never enabled answers `CHAIN_NOT_ENABLED`
 * (ADR-0010) from `get()`, never a crash. ADR-0060: each enabled chain has
 * one or more Senders, each with its own handler.
 */
export class ChainRegistry {
  /**
   * Per enabled chain, the handler for work that belongs to no Sender (a Relay
   * Dispatch, or a Sender no longer configured): its default Sender's, else
   * its first. The single-Sender shape the Coordinator takes as `chainHandlers`.
   */
  readonly handlers: ReadonlyMap<Chain, ChainHandler>;
  readonly senders: readonly RegisteredSender[];

  private constructor(senders: readonly RegisteredSender[]) {
    this.senders = senders;
    const handlers = new Map<Chain, ChainHandler>();
    for (const sender of senders) {
      if (sender.isDefault || !handlers.has(sender.chain))
        handlers.set(sender.chain, sender.handler);
    }
    this.handlers = handlers;
  }

  /**
   * The single-Sender shape: one handler per enabled chain, from the full set
   * of loaders this build knows how to construct — importing (and so running
   * the constructor of) only the ones actually enabled. Each becomes its
   * chain's default Sender, named `default`.
   */
  static async load(
    enabledChains: readonly Chain[],
    loaders: Partial<Record<Chain, ChainHandlerLoader>>,
  ): Promise<ChainRegistry> {
    const senders: RegisteredSender[] = [];
    for (const chain of enabledChains) {
      const loader = loaders[chain];
      if (!loader) {
        throw new Error(
          `ENABLED_CHAINS names "${chain}" but this build has no Chain Handler loader registered for it.`,
        );
      }
      senders.push({
        chain,
        name: DEFAULT_SENDER_NAME,
        address: null,
        isDefault: true,
        handler: await loader(),
      });
    }
    return new ChainRegistry(senders);
  }

  /** ADR-0060: a registry of named Senders, already built and checked by their loaders. */
  static fromSenders(senders: readonly RegisteredSender[]): ChainRegistry {
    for (const chain of CHAINS) {
      const defaults = senders.filter((s) => s.chain === chain && s.isDefault);
      if (defaults.length > 1) {
        throw new Error(`chain "${chain}" has more than one default Sender`);
      }
    }
    return new ChainRegistry(senders);
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

  sendersOf(chain: Chain): RegisteredSender[] {
    return this.senders.filter((s) => s.chain === chain);
  }

  /** ADR-0060: the Sender a Managed Dispatch pays from: the one it names, or its chain's default. */
  resolveSender(chain: Chain, name: string | undefined): Result<RegisteredSender, DispatchError> {
    if (!this.isEnabled(chain)) {
      return err({ code: 'CHAIN_NOT_ENABLED', message: `chain not enabled: ${chain}` });
    }
    const senders = this.sendersOf(chain);
    const names = senders.map((s) => s.name).join(', ');
    if (name === undefined) {
      const fallback = senders.find((s) => s.isDefault);
      if (fallback) return ok(fallback);
      return err({
        code: 'SENDER_REQUIRED',
        message: `${chain} has no default Sender: name one with "sender" (${names})`,
      });
    }
    const named = senders.find((s) => s.name === name);
    if (named) return ok(named);
    return err({
      code: 'UNKNOWN_SENDER',
      message: `${chain} has no Sender named "${name}" (${names})`,
    });
  }

  /** The configured name of the Sender at `address` on `chain`, or null when no Sender there has it (any more). */
  nameOf(chain: Chain, address: string): SenderName | null {
    return this.senders.find((s) => s.chain === chain && s.address === address)?.name ?? null;
  }
}
