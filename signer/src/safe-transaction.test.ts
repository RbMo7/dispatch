import { randomBytes } from 'node:crypto';

import { recoverAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { signWith } from './backends/raw-key.js';
import { parseSafeTransaction, safeSignature, safeTransactionDigest } from './safe-transaction.js';
import vectors from './safe-vectors.json' with { type: 'json' };

/** Safe 1.4.1+L2 and 1.3.0 transactions from the #79 spike, each hash confirmed by viem, the Safe SDK and the contract's own `getTransactionHash`. */
describe('safeTransactionDigest', () => {
  it.each(vectors)('matches the Safe contract’s hash for $name', ({ tx, safeTxHash }) => {
    const parsed = parseSafeTransaction(tx);
    if (typeof parsed === 'string') throw new Error(parsed);

    expect(toHex(safeTransactionDigest(parsed))).toBe(safeTxHash);
  });

  it('changes with the chain, the Safe and the nonce, which the domain and struct bind', () => {
    const [vector] = vectors;
    const base = parseSafeTransaction(vector?.tx);
    if (typeof base === 'string') throw new Error(base);
    const digest = toHex(safeTransactionDigest(base));

    expect(toHex(safeTransactionDigest({ ...base, chainId: 8453 }))).not.toBe(digest);
    expect(
      toHex(safeTransactionDigest({ ...base, safe: '0x1111111111111111111111111111111111111111' })),
    ).not.toBe(digest);
    expect(toHex(safeTransactionDigest({ ...base, nonce: base.nonce + 1n }))).not.toBe(digest);
  });
});

describe('safeSignature', () => {
  const key = randomBytes(32);
  const account = privateKeyToAccount(toHex(key));
  const digest = Uint8Array.from(randomBytes(32));

  it('turns the backend’s recovery bit into a v of 27 or 28 that recovers to the key', async () => {
    const signed = safeSignature(signWith('secp256k1', key, digest));

    expect(signed).toHaveLength(65);
    expect([27, 28]).toContain(signed[64]);
    expect(await recoverAddress({ hash: toHex(digest), signature: toHex(signed) })).toBe(
      account.address,
    );
  });

  it('refuses a signature that is not r || s || a recovery bit', () => {
    expect(() => safeSignature(new Uint8Array(64))).toThrow(/recovery bit/);
    expect(() => safeSignature(Uint8Array.from([...new Uint8Array(64), 27]))).toThrow(
      /recovery bit/,
    );
  });
});

describe('parseSafeTransaction', () => {
  const valid = vectors[0]?.tx as Record<string, unknown>;

  it('accepts a complete transaction and lowercases its addresses', () => {
    const parsed = parseSafeTransaction(valid);

    expect(parsed).toMatchObject({
      safe: '0x84ac281b68de095f6227050f56c74d93d294e609',
      chainId: 84532,
      value: 1_000_000_000_000_000n,
      operation: 0,
      nonce: 0n,
    });
  });

  it.each([
    ['not an object', 'nope', /must be an object/],
    ['an array', [], /must be an object/],
    ['a missing safe', { ...valid, safe: undefined }, /safe must be an EVM address/],
    ['a bad to', { ...valid, to: '0x1234' }, /to must be an EVM address/],
    ['a string chainId', { ...valid, chainId: '84532' }, /chainId must be a positive integer/],
    ['a zero chainId', { ...valid, chainId: 0 }, /chainId must be a positive integer/],
    ['a numeric value', { ...valid, value: 5 }, /value must be a decimal string/],
    ['a negative value', { ...valid, value: '-1' }, /value must be a decimal string/],
    ['a value over 256 bits', { ...valid, value: (2n ** 256n).toString() }, /value must be/],
    ['odd-length data', { ...valid, data: '0xabc' }, /data must be 0x-prefixed hex/],
    ['non-hex data', { ...valid, data: '0xzz' }, /data must be 0x-prefixed hex/],
    ['an unknown operation', { ...valid, operation: 2 }, /operation must be 0 or 1/],
    ['a missing nonce', { ...valid, nonce: undefined }, /nonce must be a decimal string/],
    ['a numeric nonce', { ...valid, nonce: 3 }, /nonce must be a decimal string/],
    ['a missing gasToken', { ...valid, gasToken: undefined }, /gasToken must be an EVM address/],
  ])('rejects %s', (_, raw, message) => {
    const parsed = parseSafeTransaction(raw);

    expect(typeof parsed).toBe('string');
    expect(parsed).toMatch(message);
  });
});
