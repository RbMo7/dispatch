import { BaseError, HttpRequestError, RpcError, TimeoutError } from 'viem';

import type { DispatchError, DispatchErrorCode } from '../../domain/errors.js';

/**
 * #10: the dedicated pass mapping every failure this handler can produce
 * into ADR-0010's structured shape (mirroring `solana-chain-handler` issue
 * 09). Built from the real shapes Base Sepolia and viem actually return
 * (ADR-0013, observed 2026-09-25):
 *
 * - **Transport failures** are viem `HttpRequestError`/`TimeoutError`:
 *   connection refused ("fetch failed"), any HTTP error status (503, 429,
 *   …), the engine's own fetch deadline (rpc-timeout.ts: "aborted due to
 *   timeout"), and viem's own request timeout. They are classified by
 *   error class, not by text: an HTTP 503's text says nothing about
 *   availability. All of these map to `RPC_UNAVAILABLE`.
 * - **Node rejections** are viem `RpcError`s. The node's own words ("nonce
 *   too low: next nonce 77, tx nonce 0", "invalid chain ID", "intrinsic gas
 *   too low") are in `details`, while viem's wrapper text is generic ("Missing
 *   or invalid parameters."). So `details` becomes the message, and the
 *   JSON-RPC code plus the full text go in `chainDetail`.
 *
 * A rejection this doesn't recognize still lands safely on `CHAIN_REJECTED`
 * with everything preserved, never silently dropped.
 */
export function mapBaseFailure(cause: unknown): DispatchError {
  const message = extractMessage(cause);
  const details = cause instanceof BaseError ? cause.details || undefined : undefined;
  const nodeText = details ?? summarize(message);

  const rpcError =
    cause instanceof BaseError ? cause.walk((e) => e instanceof RpcError) : undefined;
  const httpError =
    cause instanceof BaseError ? cause.walk((e) => e instanceof HttpRequestError) : undefined;
  const chainDetail: Record<string, unknown> = { message };
  if (rpcError instanceof RpcError) chainDetail.rpcCode = rpcError.code;
  if (details) chainDetail.details = details;
  if (httpError instanceof HttpRequestError && httpError.status !== undefined) {
    chainDetail.httpStatus = httpError.status;
  }

  return { code: classify(cause, `${nodeText}\n${message}`), message: nodeText, chainDetail };
}

function classify(cause: unknown, text: string): DispatchErrorCode {
  if (isTransportFailure(cause) || isRateLimitOrTimeout(text)) return 'RPC_UNAVAILABLE';
  if (isInsufficientFunds(text)) return 'INSUFFICIENT_FUNDS';
  if (isNonceTooLow(text)) return 'NONCE_ALREADY_USED';
  return 'CHAIN_REJECTED';
}

/** The request never got a JSON-RPC answer from the node at all. */
function isTransportFailure(cause: unknown): boolean {
  return (
    cause instanceof BaseError &&
    cause.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null
  );
}

/** Fallback for a non-viem error, and for a node that answers a rate limit as a JSON-RPC error rather than an HTTP 429. */
function isRateLimitOrTimeout(message: string): boolean {
  return /429|too many requests|rate.?limit|timed? ?out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(
    message,
  );
}

function isInsufficientFunds(message: string): boolean {
  return /insufficient funds/i.test(message);
}

/** #9: the nonce was already consumed on-chain — geth/op-geth's own "nonce too low" text. */
function isNonceTooLow(message: string): boolean {
  return /nonce too low/i.test(message);
}

function summarize(message: string): string {
  const firstLine = message.split('\n')[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : 'Base RPC call failed';
}

export function extractMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause);
}
