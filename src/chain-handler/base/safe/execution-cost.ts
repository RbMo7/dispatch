import {
  concat,
  encodeFunctionData,
  keccak256,
  parseAbi,
  serializeTransaction,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { estimateFeeFields } from '../fee-estimation.js';

/** `execTransaction`, as the Safe 1.3.0 and 1.4.1 contracts declare it. */
export const EXEC_TRANSACTION_ABI = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) returns (bool success)',
]);

/** The OP Stack's GasPriceOracle predeploy: prices the L1 data fee of a transaction's bytes. */
export const GAS_PRICE_ORACLE: Address = '0x420000000000000000000000000000000000000F';
const GAS_PRICE_ORACLE_ABI = parseAbi(['function getL1Fee(bytes _data) view returns (uint256)']);

/**
 * Gas of an `execTransaction` that pays `k` items through MultiSendCallOnly
 * with `t` signatures: `FIXED + PER_SIGNATURE * t + PER_ITEM * k`. Fitted
 * above the spike #79 measurements (2 signatures, fresh recipients, the worst
 * storage case): 105k (1 item), 396k (10), 879k (25), 1.67M (50), 3.27M (100).
 * Every measured point sits under this, by 3 to 10 percent: estimates may
 * over-ask, never under-ask (ADR-0043).
 */
export const GAS_FIXED = 60_000n;
export const GAS_PER_SIGNATURE = 8_000n;
export const GAS_PER_ITEM = 35_000n;
/** The executor's gas limit is the node's estimate times 12/10 (spike #79: estimates ran 2 to 3 percent under usage). */
export const GAS_MARGIN_NUMERATOR = 12n;
export const GAS_MARGIN_DENOMINATOR = 10n;
/** The L1 base fee can move between estimate and inclusion: the L1 part is doubled, like the L2 fee cap (fee-estimation.ts). */
export const L1_FEE_MULTIPLIER = 2n;

export function withGasMargin(gas: bigint): bigint {
  return (gas * GAS_MARGIN_NUMERATOR + GAS_MARGIN_DENOMINATOR - 1n) / GAS_MARGIN_DENOMINATOR;
}

export function estimateExecutionGas(items: number, signatures: number): bigint {
  return GAS_FIXED + GAS_PER_SIGNATURE * BigInt(signatures) + GAS_PER_ITEM * BigInt(items);
}

/** `count` deterministic 65-byte values that do not compress, standing in for signatures: the L1 data fee prices compressed size. */
export function dummySignatures(count: number): Hex {
  const parts: Hex[] = [];
  for (let i = 0; i < count; i++) {
    parts.push(
      concat([
        keccak256(toHex(`dispatch-dummy-signature-r-${i}`)),
        keccak256(toHex(`dispatch-dummy-signature-s-${i}`)),
        '0x1b',
      ]),
    );
  }
  return concat(parts);
}

export type ExecutionCostClient = Pick<PublicClient, 'getBlock' | 'readContract'>;

/**
 * What the executor must hold for ONE `execTransaction` of `calldata` to
 * `safe`: the L2 fee cap times the gas limit (what the node requires at
 * inclusion) plus the doubled L1 data fee of the serialized transaction.
 */
export async function estimateExecutionCost(
  client: ExecutionCostClient,
  input: { safe: Address; chainId: number; calldata: Hex; items: number; signatures: number },
): Promise<bigint> {
  const block = await client.getBlock();
  if (block.baseFeePerGas === null) {
    throw new Error('latest Base block has no baseFeePerGas — pre-EIP-1559 RPC response?');
  }
  const { maxFeePerGas, maxPriorityFeePerGas } = estimateFeeFields(block.baseFeePerGas);
  const gas = withGasMargin(estimateExecutionGas(input.items, input.signatures));

  const serialized = serializeTransaction({
    type: 'eip1559',
    chainId: input.chainId,
    nonce: 0xffffff,
    to: input.safe,
    value: 0n,
    data: input.calldata,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });
  const l1Fee = await client.readContract({
    address: GAS_PRICE_ORACLE,
    abi: GAS_PRICE_ORACLE_ABI,
    functionName: 'getL1Fee',
    args: [serialized],
  });
  return gas * maxFeePerGas + l1Fee * L1_FEE_MULTIPLIER;
}

/** The calldata of an `execTransaction` for a Safe transaction, with the given packed signatures. */
export function encodeExecTransaction(
  tx: {
    to: Address;
    value: string;
    data: Hex;
    operation: 0 | 1;
    safeTxGas: string;
    baseGas: string;
    gasPrice: string;
    gasToken: Address;
    refundReceiver: Address;
  },
  signatures: Hex,
): Hex {
  return encodeFunctionData({
    abi: EXEC_TRANSACTION_ABI,
    functionName: 'execTransaction',
    args: [
      tx.to,
      BigInt(tx.value),
      tx.data,
      tx.operation,
      BigInt(tx.safeTxGas),
      BigInt(tx.baseGas),
      BigInt(tx.gasPrice),
      tx.gasToken,
      tx.refundReceiver,
      signatures,
    ],
  });
}
