import type { Logger } from 'pino';

import type { Chain } from './domain/chain.js';
import type { DispatchStore } from './repository/dispatch-store.js';
import type { PolicyRead } from './signer/client.js';

/** ADR-0059: how often the worker reads each Sender key's pins; the Senders view can lag the Signer by this much. */
export const SIGNER_KEYS_TICK_MS = 5 * 60_000;

/** A Signer message can carry its URL, and so a secret in it: only these fixed reasons are recorded. */
const READ_ERRORS: Record<Exclude<PolicyRead['kind'], 'pins'>, string> = {
  'no-key': 'the Signer has no key for this address',
  'old-signer': 'the Signer is too old to report a key policy',
  unreachable: 'the Signer could not be reached',
};

export type SignerKeyReadDeps = {
  /** The key the engine signs with, per enabled chain: the Sender, or a Multisig Sender's engine key. */
  keys: readonly { chain: Chain; address: string }[];
  readPins: (address: string) => Promise<PolicyRead>;
  store: Pick<DispatchStore, 'recordSignerKey'>;
  now: () => Date;
  logger: Logger;
};

export async function readSignerKeys(deps: SignerKeyReadDeps): Promise<void> {
  for (const { chain, address } of deps.keys) {
    const read = await deps
      .readPins(address)
      .catch((cause: unknown): PolicyRead => ({ kind: 'unreachable', message: String(cause) }));
    if (read.kind !== 'pins')
      deps.logger.warn({ chain, address, read }, 'Signer policy read failed');
    await deps.store.recordSignerKey({
      chain,
      address,
      read: read.kind === 'pins' ? { pins: read.pins } : { error: READ_ERRORS[read.kind] },
      readAt: deps.now(),
    });
  }
}

export async function signerKeysLoop(
  deps: SignerKeyReadDeps & {
    isRunning: () => boolean;
    sleep: (ms: number) => Promise<void>;
  },
): Promise<void> {
  while (deps.isRunning()) {
    try {
      await readSignerKeys(deps);
    } catch (cause) {
      deps.logger.error({ err: cause }, 'worker signer-keys tick failed');
    }
    if (!deps.isRunning()) break;
    await deps.sleep(SIGNER_KEYS_TICK_MS);
  }
}
