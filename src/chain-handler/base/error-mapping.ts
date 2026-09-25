import type { DispatchError, DispatchErrorCode } from '../../domain/errors.js';

/**
 * A minimal classification, just enough for issue 03's own requirement
 * ("a rejected/unreachable RPC call is a structured DispatchError, never a
 * thrown exception") — issue 10 is the dedicated pass mapping every real
 * RPC/receipt failure mode this handler can produce (mirroring
 * `solana-chain-handler` issue 09), built against real Base Sepolia
 * failure text the way that pass was.
 */
export function mapBaseFailure(cause: unknown): DispatchError {
  const message = extractMessage(cause);
  return { code: classify(message), message: summarize(message), chainDetail: message };
}

function classify(message: string): DispatchErrorCode {
  if (isRateLimitOrTimeout(message)) return 'RPC_UNAVAILABLE';
  if (isInsufficientFunds(message)) return 'INSUFFICIENT_FUNDS';
  if (isNonceTooLow(message)) return 'NONCE_ALREADY_USED';
  return 'CHAIN_REJECTED';
}

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
