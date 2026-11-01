export type DispatchErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECIPIENT'
  | 'SIGNER_UNREACHABLE'
  /** ADR-0046: the Signer answered 403 `{ error, reason }`, a deliberate policy refusal. Definite, never retried. */
  | 'SIGNER_REFUSED'
  | 'CHAIN_REJECTED'
  | 'RPC_UNAVAILABLE'
  | 'CHAIN_NOT_ENABLED'
  /** A Payment names an `asset` this Chain Handler has no known encoding for (ADR-0029) — chain-agnostic, so added here rather than invented per chain. */
  | 'UNKNOWN_ASSET'
  /** #9 (ADR-0037): the transaction's nonce was already consumed on-chain. For a fee-bump, some version already landed, so bumping stops (never reported). On a first broadcast it fails that Call, e.g. after a stale nonce counter. */
  | 'NONCE_ALREADY_USED'
  /** #20 review (ADR-0041): the node already has these exact bytes pooled — sent, not refused. Ambiguous, never a Call's FAILED. */
  | 'ALREADY_KNOWN'
  /** ADR-0049/0054: the multisig's Approvers rejected (or cancelled) the Proposal, or it went stale. Definite: the Call is FAILED. */
  | 'APPROVAL_REJECTED'
  /** ADR-0053: nobody decided on the Proposal by its deadline. The Call is ABANDONED, not FAILED: an Approver may still approve it and someone else execute it. */
  | 'APPROVAL_TIMEOUT'
  /** ADR-0060: a Managed Dispatch names a Sender its chain does not have. */
  | 'UNKNOWN_SENDER'
  /** ADR-0060: a Managed Dispatch names no Sender, and its chain has no default. */
  | 'SENDER_REQUIRED';

export type DispatchError = {
  code: DispatchErrorCode;
  message: string;
  chainDetail?: unknown;
};
