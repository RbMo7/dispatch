import type { ChainHandler } from '../chain-handler/chain-handler.js';
import type { SenderRef } from '../domain/sender.js';

/**
 * ADR-0060: the unit of execution. Claims, the Funding Check, bundling,
 * signing, Proposals and send concurrency are all per Sender, each through
 * its own handler, so one Sender's queue, stuck transaction or open Proposal
 * never holds up another's.
 */
export type CoordinatorSender = {
  ref: SenderRef;
  handler: ChainHandler;
  /** Takes over every Dispatch of its chain stored with no Sender. At most one per chain. */
  isDefault: boolean;
  /** A Multisig Sender's approval deadline (ADR-0053); the Coordinator's default when unset. */
  approvalDeadlineMs?: number | undefined;
  /** A Multisig Sender's re-watch window (ADR-0053); the Coordinator's default when unset. */
  approvalRewatchWindowMs?: number | undefined;
};
