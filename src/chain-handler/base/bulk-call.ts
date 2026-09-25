import { encodeFunctionData, type Address, type Hex } from 'viem';

import type { EvmCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
import type { BundleSlotStatus } from '../chain-handler.js';

/**
 * #11 (ADR-0038): Bulk Call's pure parts — encoding a chunk against
 * Multicall3's `aggregate3Value` interface, splitting a batch into chunks,
 * and reading each item's own outcome back out of a `callTracer` trace.
 */

/** Multicall3's canonical, permissionless deployment — the same address on every chain, Base included. */
export const CANONICAL_MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Just the one Multicall3 function Bulk Call uses (viem's own `multicall3Abi` doesn't include it). */
export const AGGREGATE3_VALUE_ABI = [
  {
    type: 'function',
    name: 'aggregate3Value',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      {
        name: 'returnData',
        type: 'tuple[]',
        components: [
          { name: 'success', type: 'bool' },
          { name: 'returnData', type: 'bytes' },
        ],
      },
    ],
  },
] as const;

/** One chunk's calldata, and the native value the aggregator must be sent to forward — the sum of its items'. */
export function encodeAggregate3Value(calls: EvmCall[]): { data: Hex; value: bigint } {
  const call3Values = calls.map((call) => ({
    target: call.to as Address,
    allowFailure: true, // one bad item never takes its batch-mates down
    value: BigInt(call.value),
    callData: call.data as Hex,
  }));
  return {
    data: encodeFunctionData({ abi: AGGREGATE3_VALUE_ABI, args: [call3Values] }),
    value: call3Values.reduce((total, c) => total + c.value, 0n),
  };
}

export function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** The subset of geth's `callTracer` frame this reads. */
export type CallTrace = {
  type: string;
  to?: string;
  error?: string;
  output?: string;
  calls?: CallTrace[];
};

/**
 * Each slot's outcome from a mined bundle's trace. `aggregate3Value` makes
 * exactly one direct sub-call per item, in order, so the aggregator frame's
 * `calls[i]` is item i. A reverted aggregator frame fails every slot.
 */
export function slotsFromTrace(
  trace: CallTrace,
  itemCount: number,
): Result<BundleSlotStatus[], DispatchError> {
  if (trace.error) {
    return ok(
      Array.from({ length: itemCount }, () => ({
        status: 'FAILED' as const,
        detail: { error: `bundle reverted: ${trace.error}` },
      })),
    );
  }
  const subCalls = trace.calls ?? [];
  if (subCalls.length !== itemCount) {
    return err({
      code: 'CHAIN_REJECTED',
      message: `bundle trace has ${subCalls.length} sub-calls, expected ${itemCount} — not an aggregate3Value bundle?`,
      chainDetail: { subCalls: subCalls.length, itemCount },
    });
  }
  return ok(
    subCalls.map((sub) =>
      sub.error
        ? { status: 'FAILED' as const, detail: { error: sub.error, revert: sub.output } }
        : { status: 'CONFIRMED' as const },
    ),
  );
}
