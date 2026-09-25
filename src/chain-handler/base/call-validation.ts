import { isAddress, isHex } from 'viem';

import type { EvmCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';

/**
 * issues 03/05: cheap shape validation only, dispatched on nothing chain-
 * specific — an `EvmCall` is `{to, data, value}` whether it came from
 * `paymentToCall` (a native or ERC-20 transfer) or a caller-supplied raw
 * contract call (ADR-0018/0027: `data` is opaque, never interpreted here).
 * Never an RPC round-trip.
 */
export function validateEvmCall(call: EvmCall): Result<void, DispatchError> {
  if (!isAddress(call.to)) {
    return err({ code: 'INVALID_RECIPIENT', message: `not a well-formed EVM address: ${call.to}` });
  }
  if (!isHex(call.data) || call.data.length % 2 !== 0) {
    return err({
      code: 'CHAIN_REJECTED',
      message: `call data is not a well-formed (whole-byte) hex string: ${call.data}`,
    });
  }
  try {
    if (BigInt(call.value) < 0n) throw new Error('negative value');
  } catch {
    return err({
      code: 'CHAIN_REJECTED',
      message: `call value is not a non-negative integer string: ${call.value}`,
    });
  }
  return ok(undefined);
}
