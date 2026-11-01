/**
 * ADR-0064: what to do once the node answers "nonce too low" for a
 * Transaction this engine signed. Pure: the Coordinator gathers the facts
 * and acts on the answer.
 */

/** What a receipt read found for one version of the Call. */
export type VersionRead = 'landed' | 'no_receipt' | 'unreadable';

export type TakenNonceFacts = {
  /**
   * Whether any version of the Call may have reached a node before this
   * answer. False only for bytes refused on their very first send, which
   * cannot have landed whatever a receipt read says.
   */
  everSent: boolean;
  /** "Nonce too low" answers so far for the latest version, this one included. */
  answers: number;
  /** One read per version: the latest and every fee-bump version it replaced. */
  versions: readonly VersionRead[];
  /** Earlier resends of this Call for a taken nonce. */
  resends: number;
};

export type TakenNonceDecision =
  /** A version landed: normal resolution settles the Call. */
  | 'confirmed'
  /** Not proven either way yet: stays PENDING. */
  | 'wait'
  /** Provably never landed: send the same Calls again at a fresh nonce. */
  | 'resend'
  /** Provably never landed, and out of resends. */
  | 'fail';

export const MAX_TAKEN_NONCE_RESENDS = 3;

/**
 * A version that may have reached a node needs the answer twice, a stuck
 * interval apart: an RPC can route the receipt read to a node a block behind
 * the one that refused the send, and resending a payment that did land
 * would pay it twice.
 */
const ANSWERS_NEEDED_ONCE_SENT = 2;

export function decideTakenNonce(facts: TakenNonceFacts): TakenNonceDecision {
  if (facts.versions.includes('landed')) return 'confirmed';
  if (facts.versions.includes('unreadable')) return 'wait';
  if (facts.everSent && facts.answers < ANSWERS_NEEDED_ONCE_SENT) return 'wait';
  return facts.resends < MAX_TAKEN_NONCE_RESENDS ? 'resend' : 'fail';
}
