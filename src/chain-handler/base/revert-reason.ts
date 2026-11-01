import { BaseError, decodeErrorResult, type Hex } from 'viem';

/** Solidity's `Panic(uint256)` codes, as the compiler documents them. */
const PANICS: Record<string, string> = {
  '1': 'assertion failed',
  '17': 'arithmetic overflow or underflow',
  '18': 'division by zero',
  '33': 'invalid enum value',
  '34': 'invalid storage byte array',
  '49': 'pop on an empty array',
  '50': 'array index out of bounds',
  '65': 'out of memory',
  '81': 'call to an invalid internal function',
};

export type RevertReason = { reason: string; revertData: Hex | null };

/** The revert data an `eth_call` failure carries, wherever viem nested it. */
export function revertDataOf(cause: unknown): Hex | undefined {
  if (!(cause instanceof BaseError)) return undefined;
  const found = cause.walk((e) => {
    const data = (e as { data?: unknown }).data;
    return typeof data === 'string' || typeof (data as { data?: unknown })?.data === 'string';
  }) as { data?: string | { data?: string } } | null;
  const data = typeof found?.data === 'object' ? found.data.data : found?.data;
  return typeof data === 'string' && data.startsWith('0x') ? (data as Hex) : undefined;
}

/** Pure: revert data into words. `Error(string)` gives its message, `Panic` its meaning, anything else its selector. */
export function revertReason(data: Hex | undefined): RevertReason {
  if (data === undefined || data === '0x')
    return { reason: 'reverted with no reason', revertData: null };
  try {
    const { errorName, args } = decodeErrorResult({ abi: [], data });
    if (errorName === 'Error') return { reason: String(args[0]), revertData: data };
    const code = String(args[0]);
    return {
      reason: `panic 0x${BigInt(code).toString(16)}: ${PANICS[code] ?? 'unknown panic code'}`,
      revertData: data,
    };
  } catch {
    return { reason: `custom error ${data.slice(0, 10)}`, revertData: data };
  }
}
