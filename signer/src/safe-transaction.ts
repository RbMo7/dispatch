import { hashTypedData, hexToBytes, isAddress, isHex, type Address, type Hex } from 'viem';

/**
 * A Safe transaction as it crosses the wire (ADR-0052): addresses as hex
 * strings, uint256 fields as decimal strings, since JSON numbers can't hold
 * them exactly.
 */
export type SafeTransaction = {
  safe: Address;
  chainId: number;
  to: Address;
  value: bigint;
  data: Hex;
  /** 0 is a call, 1 a delegatecall. */
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
};

const UINT256_MAX = 2n ** 256n - 1n;

/** What Safe 1.3.0 and 1.4.1 (and their L2 variants) hash: the domain is `{ chainId, verifyingContract }` only, measured in the #79 spike. */
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the request's `safeTransaction`. Returns the first problem as a
 * message rather than a partial transaction: the Signer signs a digest of
 * exactly these fields, so a missing one is never defaulted.
 */
export function parseSafeTransaction(raw: unknown): SafeTransaction | string {
  if (!isRecord(raw)) return 'safeTransaction must be an object';

  const problem = (field: string, expected: string) => `safeTransaction.${field} must be ${expected}`;
  const address = (field: string): Address | undefined => {
    const value = raw[field];
    return typeof value === 'string' && isAddress(value, { strict: false })
      ? (value.toLowerCase() as Address)
      : undefined;
  };
  const uint256 = (field: string): bigint | undefined => {
    const value = raw[field];
    return typeof value === 'string' && /^\d+$/.test(value) && BigInt(value) <= UINT256_MAX
      ? BigInt(value)
      : undefined;
  };

  const { chainId, data, operation } = raw;
  const safe = address('safe');
  const to = address('to');
  const gasToken = address('gasToken');
  const refundReceiver = address('refundReceiver');
  const value = uint256('value');
  const safeTxGas = uint256('safeTxGas');
  const baseGas = uint256('baseGas');
  const gasPrice = uint256('gasPrice');
  const nonce = uint256('nonce');

  if (safe === undefined) return problem('safe', 'an EVM address');
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) {
    return problem('chainId', 'a positive integer');
  }
  if (to === undefined) return problem('to', 'an EVM address');
  if (value === undefined) return problem('value', 'a decimal string of at most 256 bits');
  if (typeof data !== 'string' || !isHex(data, { strict: true }) || data.length % 2 !== 0) {
    return problem('data', '0x-prefixed hex of whole bytes');
  }
  if (operation !== 0 && operation !== 1) return problem('operation', '0 or 1');
  if (safeTxGas === undefined) return problem('safeTxGas', 'a decimal string of at most 256 bits');
  if (baseGas === undefined) return problem('baseGas', 'a decimal string of at most 256 bits');
  if (gasPrice === undefined) return problem('gasPrice', 'a decimal string of at most 256 bits');
  if (gasToken === undefined) return problem('gasToken', 'an EVM address');
  if (refundReceiver === undefined) return problem('refundReceiver', 'an EVM address');
  if (nonce === undefined) return problem('nonce', 'a decimal string of at most 256 bits');

  return {
    safe,
    chainId,
    to,
    value,
    data,
    operation,
    safeTxGas,
    baseGas,
    gasPrice,
    gasToken,
    refundReceiver,
    nonce,
  };
}

/**
 * The EIP-712 hash of a Safe transaction, `keccak256(0x1901 || domainSeparator
 * || structHash)`: what the Safe contract checks owners' signatures against,
 * and what the Transaction Service accepts a signature over. The engine
 * computes the same value itself to verify what it gets back.
 */
export function safeTransactionDigest(tx: SafeTransaction): Uint8Array {
  return hexToBytes(
    hashTypedData({
      domain: { chainId: tx.chainId, verifyingContract: tx.safe },
      types: SAFE_TX_TYPES,
      primaryType: 'SafeTx',
      message: {
        to: tx.to,
        value: tx.value,
        data: tx.data,
        operation: tx.operation,
        safeTxGas: tx.safeTxGas,
        baseGas: tx.baseGas,
        gasPrice: tx.gasPrice,
        gasToken: tx.gasToken,
        refundReceiver: tx.refundReceiver,
        nonce: tx.nonce,
      },
    }),
  );
}

/**
 * The wire signature of a Safe transaction: a backend's `r || s || recovery`
 * with the recovery bit (0 or 1) turned into Safe's `v` of 27 or 28. The
 * Transaction Service rejects a raw 0 or 1.
 */
export function safeSignature(backendSignature: Uint8Array): Uint8Array {
  const recovery = backendSignature[64];
  if (backendSignature.length !== 65 || (recovery !== 0 && recovery !== 1)) {
    throw new Error('expected a 65-byte secp256k1 signature ending in a recovery bit of 0 or 1');
  }
  return Uint8Array.from([...backendSignature.subarray(0, 64), recovery + 27]);
}
