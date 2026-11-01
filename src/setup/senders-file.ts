import { getAddress } from 'viem';

import type { Config } from '../config.js';
import type { Chain } from '../domain/chain.js';
import { DEFAULT_SENDER_NAME, type SenderName } from '../domain/sender.js';
import type { SenderShape } from './init-plan.js';
import type { SenderSetup } from './settings.js';

export type SenderEntry = Readonly<Record<string, unknown>>;

/** One chain in the senders file (ADR-0060), as `init` reads and writes it. */
export type ChainSenders = { default?: string; senders: Record<string, SenderEntry> };

/** The senders file as JSON. Fields `init` does not know are kept as they are. */
export type SendersFile = Readonly<Record<string, ChainSenders>>;

/** The file entry for a Sender `init` sets up, whose engine key is `key`. */
export function senderEntry(chain: Chain, sender: SenderShape, key: string): SenderEntry {
  const address = chain === 'base' ? getAddress(key) : key;
  if (sender.kind === 'squads') {
    return { mode: 'squads', multisig: sender.multisig, memberKey: address };
  }
  if (sender.kind === 'safe') {
    return { mode: 'safe', safe: getAddress(sender.safe), executor: address };
  }
  return { address };
}

/** What a set number variable says, for a file field that takes a number. */
function wholeNumbers(fields: Readonly<Record<string, string>>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(fields).flatMap(([field, value]) =>
      value.trim() === '' ? [] : [[field, Number(value.trim())]],
    ),
  );
}

/**
 * The file entry for the one Sender today's variables describe, so moving
 * to a senders file keeps it. A Safe's API key is left out: BASE_SAFE_API_KEY
 * still applies to a Safe Sender that names none.
 */
export function entryFromVariables(sender: SenderSetup, config: Config): SenderEntry | undefined {
  const { accounts, multisig } = sender;
  if (!accounts) return undefined;
  if (multisig?.kind === 'squads') {
    const raw = config.solana.multisig;
    return {
      mode: 'squads',
      multisig: multisig.config.multisigAddress,
      memberKey: multisig.config.memberAddress,
      ...wholeNumbers({
        approvalDeadlineMs: raw.approvalDeadlineMs,
        approvalRewatchWindowMs: raw.approvalRewatchWindowMs,
      }),
    };
  }
  if (multisig?.kind === 'safe') {
    const raw = config.base.safe;
    return {
      mode: 'safe',
      safe: getAddress(multisig.config.safeAddress),
      executor: getAddress(multisig.config.executorAddress),
      ...(raw.txServiceUrl.trim() === '' ? {} : { txServiceUrl: raw.txServiceUrl.trim() }),
      ...wholeNumbers({
        approvalDeadlineMs: raw.approvalDeadlineMs,
        approvalRewatchWindowMs: raw.approvalRewatchWindowMs,
        bundleLimit: raw.bundleLimit,
      }),
    };
  }
  return { address: sender.chain === 'base' ? getAddress(accounts.address) : accounts.address };
}

/** `file` with one chain's Sender set: added under a new name, or replacing the one of that name. */
export function withSender(
  file: SendersFile,
  chain: Chain,
  name: SenderName,
  entry: SenderEntry,
): SendersFile {
  const current = file[chain] ?? { senders: {} };
  return {
    ...file,
    [chain]: {
      ...(current.default === undefined && Object.keys(current.senders).length === 0
        ? { default: name }
        : {}),
      ...current,
      senders: { ...current.senders, [name]: entry },
    },
  };
}

export function withDefault(file: SendersFile, chain: Chain, name: SenderName): SendersFile {
  const current = file[chain] ?? { senders: {} };
  return { ...file, [chain]: { ...current, default: name } };
}

/** The Sender names a chain has in `file`, in file order. */
export function senderNames(file: SendersFile, chain: Chain): SenderName[] {
  return Object.keys(file[chain]?.senders ?? {}) as SenderName[];
}

/** The name the one Sender of today's variables keeps in a senders file: the name the API already calls it. */
export const VARIABLES_SENDER_NAME: SenderName = DEFAULT_SENDER_NAME;
