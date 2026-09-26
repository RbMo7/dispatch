import { describe, expect, it } from 'vitest';

import {
  decodeUnsignedTransaction,
  signedTransactionHex,
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
  preparedId: 'prepared-1',
};

describe('encodeUnsignedTransaction / decodeUnsignedTransaction', () => {
  it('round-trips every field exactly', () => {
    const encoded = encodeUnsignedTransaction(ENCODED);
    expect(typeof encoded).toBe('string');
    expect(decodeUnsignedTransaction(encoded)).toEqual(ENCODED);
  });
});

describe('toViemTransaction nonce (#24)', () => {
  it('takes the nonce it is given — a prepared transaction carries none until sign assigns one', () => {
    expect(toViemTransaction({ ...ENCODED, nonce: null }, 9).nonce).toBe(9);
  });
});

describe('toViemTransaction', () => {
  it('converts JSON-safe decimal-string fields into a bigint-typed EIP-1559 transaction', () => {
    const tx = toViemTransaction(ENCODED, 3);
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

describe('signedTransactionHex (#13)', () => {
  it("passes 0x-hex through unchanged (what this handler's own sign produces)", () => {
    expect(signedTransactionHex('0x02f86a')).toBe('0x02f86a');
  });

  it("decodes base64 raw bytes (docs/api.md's Relay Dispatch wire format) to 0x-hex", () => {
    expect(signedTransactionHex(Buffer.from([0x02, 0xf8, 0x6a]).toString('base64'))).toBe(
      '0x02f86a',
    );
  });

  it('answers null for a string that is neither', () => {
    expect(signedTransactionHex('not-real-signed-bytes')).toBeNull();
    expect(signedTransactionHex('')).toBeNull();
  });
});
