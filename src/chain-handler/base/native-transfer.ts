import { isAddress } from 'viem';

import type { EvmCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';

/** issue 03: a plain native ETH transfer — no calldata needed, matching Solana's native-transfer-vs-SPL-transfer split. */
export function buildNativeTransferCall(
  recipient: string,
  amount: string,
): Result<EvmCall, DispatchError> {
  if (!isAddress(recipient)) {
    return err({ code: 'INVALID_RECIPIENT', message: `not a well-formed EVM address: ${recipient}` });
  }
  return ok({ to: recipient, data: '0x', value: amount });
}
