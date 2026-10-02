import { randomBytes } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToBigInt, numberToBytes, toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { recoverableSignature } from './secp256k1-recovery.js';

const N = secp256k1.Point.CURVE().n;

function signed() {
  const key = randomBytes(32);
  const digest = randomBytes(32);
  // noble puts the recovery byte first and always produces a low s.
  const recovered = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
  const rs = recovered.subarray(1);
  return {
    address: privateKeyToAddress(toHex(key)),
    digest,
    rs,
    expected: Uint8Array.from([...rs, recovered[0] ?? 0]),
  };
}

function withHighS(rs: Uint8Array): Uint8Array {
  const s = bytesToBigInt(rs.subarray(32));
  return Uint8Array.from([...rs.subarray(0, 32), ...numberToBytes(N - s, { size: 32 })]);
}

describe('recoverableSignature', () => {
  it('appends the recovery bit that recovers the address to a 64-byte r || s', () => {
    const { address, digest, rs, expected } = signed();

    expect(recoverableSignature(rs, digest, address)).toEqual(expected);
  });

  it.each([27, 28, 0, 1])('ignores a trailing v of %d and finds the bit itself', (v) => {
    const { address, digest, rs, expected } = signed();

    expect(recoverableSignature(Uint8Array.from([...rs, v]), digest, address)).toEqual(expected);
  });

  it('lowers a high s to n - s, flipping the recovery bit with it', () => {
    const { address, digest, rs, expected } = signed();
    const high = withHighS(rs);
    expect(bytesToBigInt(high.subarray(32, 64)) > N / 2n).toBe(true);

    expect(recoverableSignature(high, digest, address)).toEqual(expected);
  });

  it("refuses a signature that is another key's", () => {
    const { digest, rs } = signed();
    const other = privateKeyToAddress(toHex(randomBytes(32)));

    expect(() => recoverableSignature(rs, digest, other)).toThrow(
      `the signature does not recover to ${other}`,
    );
  });

  it('refuses a signature over another digest', () => {
    const { address, rs } = signed();

    expect(() => recoverableSignature(rs, randomBytes(32), address)).toThrow(/does not recover/);
  });

  it('refuses a signature of the wrong length', () => {
    const { address, digest, rs } = signed();

    expect(() => recoverableSignature(rs.subarray(0, 63), digest, address)).toThrow(
      'expected a 64- or 65-byte secp256k1 signature, got 63 bytes',
    );
  });
});
