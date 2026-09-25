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
  const viemError = cause instanceof BaseError ? cause : undefined;
  const details = viemError?.details || undefined;
  const rpcError = viemError?.walk((e) => e instanceof RpcError);
  const httpError = viemError?.walk((e) => e instanceof HttpRequestError);
  // A provider may answer a node rejection with an HTTP error status: viem
  // then raises HttpRequestError with the JSON-RPC error as its details.
  const bodyError = parseJsonRpcError(details);
  const rpcCode = rpcError instanceof RpcError ? (rpcError.code as number) : bodyError?.code;
  // Classify from the node's own words only — never viem's full message,
  // which embeds the request body (the signed transaction's hex).
  const nodeText = bodyError?.message ?? details ?? summarize(message);

  const chainDetail: Record<string, unknown> = { message };
  if (rpcCode !== undefined) chainDetail.rpcCode = rpcCode;
  if (details) chainDetail.details = details;
  if (httpError instanceof HttpRequestError && httpError.status !== undefined) {
    chainDetail.httpStatus = httpError.status;
  }

  const transport = !bodyError && isTransportFailure(cause);
  return { code: classify(nodeText, rpcCode, transport), message: nodeText, chainDetail };
}

function classify(
  nodeText: string,
  rpcCode: number | undefined,
  transport: boolean,
): DispatchErrorCode {
  if (isInsufficientFunds(nodeText)) return 'INSUFFICIENT_FUNDS';
  if (isNonceTooLow(nodeText)) return 'NONCE_ALREADY_USED';
  if (transport || rpcCode === LIMIT_EXCEEDED_RPC_CODE || isRateLimitOrTimeout(nodeText)) {
    return 'RPC_UNAVAILABLE';
  }
  return 'CHAIN_REJECTED';
}

/** EIP-1474's "limit exceeded" — how many providers answer a rate limit on HTTP 200. */
const LIMIT_EXCEEDED_RPC_CODE = -32005;

/** The request never got a JSON-RPC answer from the node at all. */
function isTransportFailure(cause: unknown): boolean {
  return (
    cause instanceof BaseError &&
    cause.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null
  );
}

function parseJsonRpcError(
  details: string | undefined,
): { code: number; message: string } | undefined {
  if (!details) return undefined;
  try {
    const parsed = JSON.parse(details) as { code?: unknown; message?: unknown };
    return typeof parsed.code === 'number' && typeof parsed.message === 'string'
      ? { code: parsed.code, message: parsed.message }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback for a non-viem error, and for a node that words a rate limit or timeout in its own text. Deliberately no bare "429": an HTTP 429 is already a transport failure by class. */
function isRateLimitOrTimeout(text: string): boolean {
  return /too many requests|rate.?limit|rate exceeded|timed? ?out|fetch failed|ECONNRESET|ETIMEDOUT/i.test(
    text,
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
