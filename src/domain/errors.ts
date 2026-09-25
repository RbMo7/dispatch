export type DispatchErrorCode =
  | 'INSUFFICIENT_FUNDS'
  | 'INVALID_RECIPIENT'
  | 'SIGNER_UNREACHABLE'
  | 'CHAIN_REJECTED'
  | 'RPC_UNAVAILABLE'
  | 'CHAIN_NOT_ENABLED'
  /** A Payment names an `asset` this Chain Handler has no known encoding for (ADR-0029) — chain-agnostic, so added here rather than invented per chain. */
  | 'UNKNOWN_ASSET'
  /** #9 (ADR-0037): the transaction's nonce was already consumed on-chain. For a fee-bump, some version already landed, so bumping stops (never reported). On a first broadcast it fails that Call, e.g. after a stale nonce counter. */
  | 'NONCE_ALREADY_USED';

export type DispatchError = {
  code: DispatchErrorCode;
  message: string;
  chainDetail?: unknown;
};
