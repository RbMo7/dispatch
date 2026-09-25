/**
 * issue 03: the fixed-multiplier fee-estimation heuristic (spec's own
 * "Implementation Decisions" section) — no `eth_feeHistory`-percentile
 * logic, no pluggable estimator interface. `maxFeePerGas` is a documented
 * constant multiplier over the latest block's own `baseFeePerGas` (reads
 * it once per `prepare()` call, not once per item); `maxPriorityFeePerGas`
 * is a documented fixed tip. Both are tunable constants here, not
 * operator config — `config.base` (issue 01) doesn't name either of them,
 * only `feeBumpPercent` (issue 09) and `bulkCallMaxBatchSize` (issue 11).
 *
 * Deliberately doesn't account for Base's L1 data fee (the OP Stack
 * GasPriceOracle component covering L1 calldata-posting cost,
 * research-base.md §4) anywhere — issue 03's own acceptance criteria
 * names only this L2 fee-field heuristic, and research-base.md's Open
 * Question #2 leaves whether the L1 fee needs its own line item
 * (Funding Check, a persisted cost field, fee-bump math) explicitly
 * undecided. A real gap for exact-cost accuracy, not an oversight here.
 */

/** Base fee can move ~12.5%/block in either direction (EIP-1559) — 2x tolerates several blocks' worth of increase between prepare() and inclusion. */
export const FEE_MULTIPLIER = 2n;

/** A small, non-zero tip — Base Sepolia's own sequencer has no real fee-market congestion to bid against. */
export const DEFAULT_PRIORITY_FEE_WEI = 1_000_000n;

export type FeeFields = {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
};

export function estimateFeeFields(baseFeePerGas: bigint): FeeFields {
  return {
    maxFeePerGas: baseFeePerGas * FEE_MULTIPLIER,
    maxPriorityFeePerGas: DEFAULT_PRIORITY_FEE_WEI,
  };
}
