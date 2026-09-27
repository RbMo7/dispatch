import type { DispatchError, DispatchErrorCode } from '../../domain/errors.js';

/**
 * `.scratch/solana-chain-handler/issues/09` — a dedicated pass mapping every
 * Solana/RPC-specific failure this Chain Handler can actually produce into
 * ADR-0010's structured shape, reusing the shared `code` taxonomy
 * (core-engine-scaffold issue 02) where a failure is genuinely the same
 * kind of thing across chains, and keeping the raw Solana detail in
 * `chainDetail` rather than inventing a new top-level code per message.
 *
 * Deliberately text-pattern-based against the real messages devnet actually
 * returns (ADR-0013 — these strings were observed against real RPC calls
 * while building issues 02-07, not guessed), not an exhaustive parse of
 * every possible program error: a raw simulation/execution failure this
 * doesn't recognize still lands safely on `CHAIN_REJECTED` with the full
 * original text preserved in `chainDetail`, never silently dropped.
 */
export function mapSolanaFailure(cause: unknown): DispatchError {
  const message = extractMessage(cause);
  const logs = extractLogs(cause);
  const chainDetail = logs ? { message, logs } : message;

  return { code: classify(message), message: summarize(message), chainDetail };
}

function classify(message: string): DispatchErrorCode {
  // A simulation failure is the chain's own verdict, whatever numbers its logs contain.
  if (!/simulation failed/i.test(message) && isRateLimitOrTimeout(message)) return 'RPC_UNAVAILABLE';
  if (isInsufficientFunds(message)) return 'INSUFFICIENT_FUNDS';
  if (isUnknownOrMissingAccount(message)) return 'INVALID_RECIPIENT';
  return 'CHAIN_REJECTED';
}

/**
 * The RPC couldn't answer, so the transaction may or may not have gone
 * through: rate limits, timeouts, dropped connections, and (mainnet review)
 * server-side failures — any 5xx from the RPC or a gateway in front of it,
 * and a node reporting itself behind. None of these is the chain refusing.
 */
function isRateLimitOrTimeout(message: string): boolean {
  return /429|too many requests|rate.?limit|timed? ?out|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|(responded with|status(code)?:?|HTTP)\s*5\d\d|\b5\d\d (service|bad|gateway|internal)|service unavailable|bad gateway|internal server error|node is (behind|unhealthy)|-32005/i.test(
    message,
  );
}

function isInsufficientFunds(message: string): boolean {
  // Covers both a plain lamports shortfall and the rent-exemption failure
  // issue 05 actually hit against real devnet (a transfer below the
  // rent-exempt minimum to a brand-new account) — the runtime's own wording
  // for both is "insufficient funds", just for different reasons.
  return /insufficient (lamports|funds)/i.test(message);
}

function isUnknownOrMissingAccount(message: string): boolean {
  return /AccountNotFound|could not find account|TokenAccountNotFoundError|InvalidAccountData/i.test(
    message,
  );
}

/** devnet's real "Blockhash not found" wording — kept as its own predicate since broadcast()'s retry loop treats it as retriable, not terminal, unlike every other case this file maps. */
export function isBlockhashExpiryMessage(message: string): boolean {
  return /blockhash not found/i.test(message);
}

function summarize(message: string): string {
  const firstLine = message.split('\n')[0]?.trim();
  return firstLine && firstLine.length > 0 ? firstLine : 'Solana RPC call failed';
}

export function extractMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  return JSON.stringify(cause);
}

/** `SendTransactionError` (web3.js) carries simulation logs separately from `.message` — surfaced in `chainDetail` when present, per issue 09's explicit "simulation failure" case. */
function extractLogs(cause: unknown): string[] | undefined {
  if (
    cause &&
    typeof cause === 'object' &&
    'logs' in cause &&
    Array.isArray((cause as { logs?: unknown }).logs)
  ) {
    return (cause as { logs: string[] }).logs;
  }
  return undefined;
}
