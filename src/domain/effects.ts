import type { Chain } from './chain.js';

/**
 * ADR-0063: what a confirmed transaction changed, read from the chain once by
 * the worker and stored raw, so a decoder added later still explains it.
 * Decoding happens only when it is read (`src/effects/`).
 */

/** One receipt log, as the node returned it. */
export type BaseLog = {
  address: string;
  topics: string[];
  /** Hex; cut to `EFFECTS_BOUNDS.dataBytes`. */
  data: string;
};

export type BaseEffects = {
  chain: 'base';
  blockNumber: string;
  from: string;
  to: string | null;
  /** Wei the transaction itself sent to `to`. */
  value: string;
  /** The transaction's input, hex, cut to `EFFECTS_BOUNDS.dataBytes`. */
  input: string;
  gasUsed: string;
  effectiveGasPrice: string;
  /** The OP Stack L1 data fee in wei, `'0'` when the node reports none. */
  l1Fee: string;
  /** What the Sender paid: `gasUsed × effectiveGasPrice + l1Fee`, wei. */
  fee: string;
  logs: BaseLog[];
  /** Set when a log, or part of the input or a log's data, was cut to the bounds. */
  truncated: boolean;
};

/** One instruction the transaction ran: a top-level one (`parent` null), or one it invoked (`parent` its top-level index). */
export type SolanaInstruction = {
  programId: string;
  accounts: string[];
  /** Base64; cut to `EFFECTS_BOUNDS.dataBytes`. */
  data: string;
  parent: number | null;
};

export type SolanaLamportBalance = { account: string; pre: string; post: string };

export type SolanaTokenBalance = {
  /** The token account. */
  account: string;
  mint: string;
  /** The wallet that owns the token account, when the node says. */
  owner: string | null;
  decimals: number;
  /** Smallest unit; `'0'` when the account did not exist on that side. */
  pre: string;
  post: string;
};

export type SolanaEffects = {
  chain: 'solana';
  slot: number;
  feePayer: string;
  /** Lamports. */
  fee: string;
  instructions: SolanaInstruction[];
  lamports: SolanaLamportBalance[];
  tokenBalances: SolanaTokenBalance[];
  logMessages: string[];
  /** Set when an entry, an instruction's data or a log line was cut to the bounds. */
  truncated: boolean;
};

export type TransactionEffects = BaseEffects | SolanaEffects;

/**
 * What one stored row may hold, so a transaction with thousands of logs can
 * never make a row unbounded: at most `entries` logs, instructions or balances
 * each, every data field cut at `dataBytes`, and at most `logLines` log lines
 * of `logLineChars` characters. About 1 MiB in the worst case; a payment is
 * well under 4 KiB.
 */
export const EFFECTS_BOUNDS = {
  entries: 128,
  dataBytes: 2048,
  logLines: 100,
  logLineChars: 300,
} as const;

/**
 * How the worker reads effects: transactions confirmed within `windowMs` are
 * read; a failed read waits `retryAfterMs` for each failure so far, and after
 * `maxFailures` the transaction is left without effects.
 */
export const EFFECTS_READ = {
  windowMs: 7 * 24 * 60 * 60_000,
  retryAfterMs: 60_000,
  maxFailures: 5,
} as const;

/** One transaction by what identifies it on its chain; Calls bundled into one transaction share it. */
export type TransactionRef = { chain: Chain; hash: string };
