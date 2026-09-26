import { encodeFunctionData, isAddress } from 'viem';

import type { EvmCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';

/** Just the two functions this Chain Handler ever calls — never a full ERC-20 interface. */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/**
 * issue 04: `{to: tokenContractAddress, data: 0xa9059cbb + recipient + amount, value: "0"}` —
 * the known ERC-20 `transfer` encoding CONTEXT.md's Payment entry names,
 * symmetric to `SolanaChainHandler`'s SPL-transfer split (ADR-0028).
 */
export function buildErc20TransferCall(
  tokenContractAddress: string,
  recipient: string,
  amount: bigint,
): Result<EvmCall, DispatchError> {
  if (!isAddress(tokenContractAddress)) {
    return err({
      code: 'CHAIN_REJECTED',
      message: `configured token contract address is not well-formed: ${tokenContractAddress}`,
    });
  }
  if (!isAddress(recipient)) {
    return err({ code: 'INVALID_RECIPIENT', message: `not a well-formed EVM address: ${recipient}` });
  }

  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });

  return ok({ to: tokenContractAddress, data, value: '0' });
}
