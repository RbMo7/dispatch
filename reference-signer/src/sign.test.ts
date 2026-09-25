import { createHash, generateKeyPairSync, randomBytes, verify as nodeVerify } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
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

  it('signs a secp256k1 digest directly (no re-hashing) and returns an r||s||recovery signature', () => {
    const scalar = randomBytes(32);
    const publicKey = secp256k1.getPublicKey(scalar, true);
    // A stand-in for a real EIP-1559 signing hash — any 32-byte digest works, since
    // signSecp256k1 must never assume anything about how it was derived.
    const digest = createHash('sha256').update(message).digest();

    const signature = sign('secp256k1', scalar.toString('hex'), digest);

    expect(signature).toHaveLength(65);
    // Decoded from our own documented r||s||recovery layout (never noble's
    // own 'recovered' byte order, which puts recovery first) — proves the
    // wire contract, not just that noble's internals are self-consistent.
    const r = BigInt('0x' + signature.subarray(0, 32).toString('hex'));
    const s = BigInt('0x' + signature.subarray(32, 64).toString('hex'));
    const recovery = signature[64];
    const parsedSignature = new secp256k1.Signature(r, s, recovery);

    const recoveredPublicKey = parsedSignature.recoverPublicKey(digest).toBytes(true);
    expect(Buffer.from(recoveredPublicKey).equals(Buffer.from(publicKey))).toBe(true);
    expect(
      secp256k1.verify(parsedSignature.toBytes('compact'), digest, publicKey, { prehash: false }),
    ).toBe(true);
  });

  it('rejects a secp256k1 message that is not a 32-byte digest', () => {
    const scalar = randomBytes(32);
    expect(() => sign('secp256k1', scalar.toString('hex'), message)).toThrow(/32-byte digest/);
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
