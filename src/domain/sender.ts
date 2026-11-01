import type { Chain } from './chain.js';

/** ADR-0060: how callers and the console refer to a Sender. Unique per chain; a label from configuration, never its identity. */
export type SenderName = string & { readonly __brand: 'SenderName' };

/**
 * ADR-0060: what pays a Sender's payments (the plain key, the Squads vault or
 * the Safe), in its chain's canonical spelling. A Dispatch stores it, so it is
 * the Sender's identity: renaming a Sender keeps its history.
 */
export type SenderAddress = string & { readonly __brand: 'SenderAddress' };

/** One Sender, as the engine keys everything that is per Sender: claims, nonces, funding, Proposals. */
export type SenderRef = { chain: Chain; address: SenderAddress };

/** The one Sender each chain has when there is no senders file (ADR-0060). */
export const DEFAULT_SENDER_NAME = 'default' as SenderName;

const SENDER_NAME = /^[a-z0-9-]{1,40}$/;

export function parseSenderName(raw: string): SenderName | undefined {
  return SENDER_NAME.test(raw) ? (raw as SenderName) : undefined;
}

/** A Map key for a Sender: a control character can never appear in a chain name or an address. */
export function senderKey(ref: SenderRef): string {
  return `${ref.chain}\u0000${ref.address}`;
}
