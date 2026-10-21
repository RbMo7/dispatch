import { hashTypedData, type Address, type Hex } from 'viem';

/**
 * ADR-0052: a Safe transaction as it crosses the Signer's wire. Addresses
 * are hex strings and every uint256 a decimal string, since JSON numbers
 * can't hold them exactly.
 */
export type SafeTransaction = {
  safe: Address;
  chainId: number;
  to: Address;
  value: string;
  data: Hex;
  /** 0 is a call, 1 a delegatecall. */
  operation: 0 | 1;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: Address;
  refundReceiver: Address;
  nonce: string;
};

/** Safe 1.3.0 and 1.4.1 (and their L2 variants) hash the domain `{ chainId, verifyingContract }` only, measured in the #79 spike. */
const SAFE_TX_TYPES = {
  SafeTx: [
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'value' },
    { type: 'bytes', name: 'data' },
    { type: 'uint8', name: 'operation' },
    { type: 'uint256', name: 'safeTxGas' },
    { type: 'uint256', name: 'baseGas' },
    { type: 'uint256', name: 'gasPrice' },
    { type: 'address', name: 'gasToken' },
    { type: 'address', name: 'refundReceiver' },
    { type: 'uint256', name: 'nonce' },
  ],
} as const;

/**
 * The EIP-712 hash of a Safe transaction: what its owners sign and the
 * Safe contract checks. The engine computes it itself, never taking it from
 * the Signer, so it can tell a signature over this transaction from any
 * other (ADR-0052). The Signer holds its own copy of the definition,
 * because the two never import each other (ADR-0002).
 */
export function safeTransactionHash(tx: SafeTransaction): Hex {
  return hashTypedData({
    domain: { chainId: tx.chainId, verifyingContract: tx.safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to: tx.to,
      value: BigInt(tx.value),
      data: tx.data,
      operation: tx.operation,
      safeTxGas: BigInt(tx.safeTxGas),
      baseGas: BigInt(tx.baseGas),
      gasPrice: BigInt(tx.gasPrice),
      gasToken: tx.gasToken,
      refundReceiver: tx.refundReceiver,
      nonce: BigInt(tx.nonce),
    },
  });
}
