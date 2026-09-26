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
  /**
   * #24 (ADR-0039): null until `sign` assigns it — assigning at prepare
   * time leaked a nonce whenever a later sign/broadcast (or the rest of the
   * batch's prepare) failed, stranding every later transaction behind the
   * gap. Set explicitly only by a fee-bump replacement, which must reuse
   * the stuck transaction's nonce.
   */
  nonce: number | null;
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
  /**
   * #24: unique per prepared transaction (shared by one Bulk chunk's
   * members). Without a nonce, two identical payments would otherwise
   * encode to identical bytes — which the Coordinator treats as one bundle,
   * silently dropping the second.
   */
  preparedId: string;
};

export function toViemTransaction(
  encoded: EncodedEvmTransaction,
  nonce: number,
): TransactionSerializableEIP1559 {
  return {
    type: 'eip1559',
    chainId: encoded.chainId,
    nonce,
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
  return JSON.parse(
    Buffer.from(unsignedTransaction, 'base64').toString('utf8'),
  ) as EncodedEvmTransaction;
}

/**
 * #13: a SignedTransaction as 0x-hex. This handler's own `sign` produces
 * 0x-hex; a Relay Dispatch caller sends the raw signed bytes as base64
 * (docs/api.md's chain-agnostic wire format), so both are accepted. Null
 * for anything that is neither.
 */
export function signedTransactionHex(signed: string): `0x${string}` | null {
  if (/^0x([0-9a-fA-F]{2})+$/.test(signed)) return signed as `0x${string}`;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signed)) return null;
  const bytes = Buffer.from(signed, 'base64');
  if (
    bytes.length === 0 ||
    bytes.toString('base64').replace(/=+$/, '') !== signed.replace(/=+$/, '')
  ) {
    return null;
  }
  return `0x${bytes.toString('hex')}`;
}
