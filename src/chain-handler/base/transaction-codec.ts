import type { Address, Hex, TransactionSerializableEIP1559 } from 'viem';

/**
 * The opaque `UnsignedTransaction`/`PreparedTransaction` encoding this
 * handler chooses (ADR-0027) — a JSON-safe mirror of an EIP-1559
 * transaction's fields (bigints as decimal strings, since JSON can't hold
 * them) plus the `senderAddress` it was built for, so `sign` can reject
 * being asked to sign as the wrong Sender (mirrors
 * `SolanaChainHandler.sign`'s own `feePayer` check). `sign` rebuilds the
 * exact same `TransactionSerializableEIP1559` object from this and
 * re-derives the unsigned serialized bytes itself — no need to also carry
 * those bytes separately.
 */
export type EncodedEvmTransaction = {
  senderAddress: Address;
  chainId: number;
  nonce: number;
  to: Address;
  /** Decimal wei. */
  value: string;
  data: Hex;
  /** Decimal gas units. */
  gas: string;
  /** Decimal wei per gas. */
  maxFeePerGas: string;
  /** Decimal wei per gas. */
  maxPriorityFeePerGas: string;
};

export function toViemTransaction(encoded: EncodedEvmTransaction): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: encoded.chainId,
    nonce: encoded.nonce,
    to: encoded.to,
    value: BigInt(encoded.value),
    data: encoded.data,
    gas: BigInt(encoded.gas),
    maxFeePerGas: BigInt(encoded.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(encoded.maxPriorityFeePerGas),
  };
}

export function encodeUnsignedTransaction(encoded: EncodedEvmTransaction): string {
  return Buffer.from(JSON.stringify(encoded)).toString('base64');
}

export function decodeUnsignedTransaction(unsignedTransaction: string): EncodedEvmTransaction {
  return JSON.parse(Buffer.from(unsignedTransaction, 'base64').toString('utf8')) as EncodedEvmTransaction;
}
