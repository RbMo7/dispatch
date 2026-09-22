import { generateKeyPairSync, verify as nodeVerify } from 'node:crypto';
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

  it('produces a secp256k1 signature that verifies against the matching public key', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    const scalar = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');

    const signature = sign('secp256k1', scalar.toString('hex'), message);

    expect(signature).toHaveLength(64);
    expect(
      nodeVerify('sha256', message, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature),
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
