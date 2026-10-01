import { generateKeyPairSync, randomBytes, verify as nodeVerify } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { describe, expect, it } from 'vitest';

import { sign } from './sign.js';

const message = Buffer.from('unsigned tx bytes go here');

describe('sign', () => {
  it('produces an ed25519 signature that verifies against the matching public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');

    const signature = sign('ed25519', seed.toString('hex'), message);

    expect(signature).toHaveLength(64);
    expect(nodeVerify(null, message, publicKey, signature)).toBe(true);
  });

  it('signs the keccak256 of a secp256k1 payload and returns an r||s||recovery signature', () => {
    const scalar = randomBytes(32);
    const publicKey = secp256k1.getPublicKey(scalar, true);

    const signature = sign('secp256k1', scalar.toString('hex'), message);

    expect(signature).toHaveLength(65);
    // Decoded from our own documented r||s||recovery layout (never noble's
    // own 'recovered' byte order, which puts recovery first) — proves the
    // wire contract, not just that noble's internals are self-consistent.
    const r = BigInt('0x' + signature.subarray(0, 32).toString('hex'));
    const s = BigInt('0x' + signature.subarray(32, 64).toString('hex'));
    const recovery = signature[64];
    const parsedSignature = new secp256k1.Signature(r, s, recovery);
    const digest = keccak_256(message);

    const recoveredPublicKey = parsedSignature.recoverPublicKey(digest).toBytes(true);
    expect(Buffer.from(recoveredPublicKey).equals(Buffer.from(publicKey))).toBe(true);
    expect(
      secp256k1.verify(parsedSignature.toBytes('compact'), digest, publicKey, { prehash: false }),
    ).toBe(true);
  });

  it('rejects a private key that is not 32 bytes', () => {
    expect(() => sign('ed25519', 'ab', message)).toThrow(/32-byte/);
  });

  it('produces different signatures for different messages under the same key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');

    const a = sign('ed25519', seed.toString('hex'), Buffer.from('message a'));
    const b = sign('ed25519', seed.toString('hex'), Buffer.from('message b'));

    expect(a.equals(b)).toBe(false);
  });
});
