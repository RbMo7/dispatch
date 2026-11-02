import type { Chain } from './chain.js';
import type { TokenKind } from './operator-action.js';

/**
 * ADR-0062: a `POST /v1/dispatch` the API refused with a 4xx other than 401.
 * `code` is the error's code when the answer had one (a `DispatchErrorCode`,
 * or the HTTP server's `FST_ERR_*`), and null for a plain `{ error }`.
 */
export type RejectedRequestError = { code: string | null; message: string; chainDetail?: unknown };

export type NewRejectedRequest = {
  status: number;
  /** The request's `chain`, when it named one the API has; the body keeps whatever was sent. */
  chain: Chain | null;
  idempotencyKey: string | null;
  tokenKind: TokenKind;
  error: RejectedRequestError;
  /** The parsed request body, every item kept; null when it was not JSON. */
  body: unknown;
};

export type RejectedRequest = NewRejectedRequest & { id: string; at: Date };

/** ADR-0062: how long refused requests are kept by default, and the most kept at once. */
export const DEFAULT_REJECTED_RETENTION_DAYS = 30;
export const REJECTED_REQUEST_CAP = 10_000;
