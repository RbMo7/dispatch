import { describe, expect, it } from 'vitest';

import {
  decodeUnsignedTransaction,
  encodeUnsignedTransaction,
  toViemTransaction,
  type EncodedEvmTransaction,
} from './transaction-codec.js';

const ENCODED: EncodedEvmTransaction = {
  senderAddress: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
  chainId: 84532,
  nonce: 3,
  to: '0x000000000000000000000000000000000000dEaD',
  value: '1000',
  data: '0x',
  gas: '21000',
  maxFeePerGas: '10000000',
  maxPriorityFeePerGas: '1000000',
};

describe('encodeUnsignedTransaction / decodeUnsignedTransaction', () => {
  it('round-trips every field exactly', () => {
    const encoded = encodeUnsignedTransaction(ENCODED);
    expect(typeof encoded).toBe('string');
    expect(decodeUnsignedTransaction(encoded)).toEqual(ENCODED);
  });
});

describe('toViemTransaction', () => {
  it('converts JSON-safe decimal-string fields into a bigint-typed EIP-1559 transaction', () => {
    const tx = toViemTransaction(ENCODED);
    expect(tx).toEqual({
      type: 'eip1559',
      chainId: 84532,
      nonce: 3,
      to: ENCODED.to,
      value: 1000n,
      data: '0x',
      gas: 21000n,
      maxFeePerGas: 10000000n,
      maxPriorityFeePerGas: 1000000n,
    });
  });
});
