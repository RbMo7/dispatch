import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Keypair } from '@solana/web3.js';
import { toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import {
  createAwsKmsBackend,
  createKmsApi,
  ed25519SpkiToAddress,
  secp256k1SpkiToAddress,
  type KmsApi,
  type KmsSdk,
} from './aws-kms.js';
import { createBackends } from './index.js';

const N = secp256k1.Point.CURVE().n;
const KEY_ID = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';

/** A key generated and SPKI-encoded by node's OpenSSL, independently of the code under test. */
function nodeKey(namedCurve = 'secp256k1') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve });
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const key = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  return { spki, key };
}

/** A KMS stand-in holding a local key: DER public key, DER signatures over the digest as given. */
function kmsKey(transform: (der: Uint8Array) => Uint8Array = (der) => der) {
  const { spki, key } = nodeKey();
  const api: KmsApi = {
    publicKey: vi.fn(() =>
      Promise.resolve({ spki, keySpec: 'ECC_SECG_P256K1', keyUsage: 'SIGN_VERIFY' }),
    ),
    signDigest: vi.fn((_keyId: string, digest: Uint8Array) =>
      Promise.resolve(transform(secp256k1.sign(digest, key, { prehash: false, format: 'der' }))),
    ),
    signRaw: vi.fn(() => Promise.reject(new Error('an ECDSA key cannot sign RAW'))),
  };
  return { key, address: privateKeyToAddress(toHex(key)), api };
}

/** An Ed25519 key generated and SPKI-encoded by node's OpenSSL, independently of the code under test. */
function nodeEd25519Key() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const spki = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  return { spki, seed };
}

/** A KMS stand-in holding a local Ed25519 key, signing the message itself. */
function kmsEd25519Key(transform: (signature: Uint8Array) => Uint8Array = (sig) => sig) {
  const { spki, seed } = nodeEd25519Key();
  const api: KmsApi = {
    publicKey: vi.fn(() =>
      Promise.resolve({ spki, keySpec: 'ECC_NIST_EDWARDS25519', keyUsage: 'SIGN_VERIFY' }),
    ),
    signDigest: vi.fn(() => Promise.reject(new Error('an Ed25519 key cannot sign ECDSA'))),
    signRaw: vi.fn((_keyId: string, message: Uint8Array) =>
      Promise.resolve(transform(ed25519.sign(message, seed))),
    ),
  };
  return { seed, address: Keypair.fromSeed(seed).publicKey.toBase58(), api };
}

function expectedSignature(key: Uint8Array, digest: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
  return Uint8Array.from([...recovered.subarray(1), recovered[0] ?? 0]);
}

/** A digest whose signature (deterministic, RFC 6979) has the given shape. */
function digestWhere(key: Uint8Array, shape: (r: bigint, s: bigint) => boolean): Uint8Array {
  for (;;) {
    const digest = randomBytes(32);
    const { r, s } = secp256k1.Signature.fromBytes(
      secp256k1.sign(digest, key, { prehash: false }),
      'compact',
    );
    if (shape(r, s)) return digest;
  }
}

function derIntegerLengths(der: Uint8Array): [number, number] {
  const rLength = der[3] ?? 0;
  return [rLength, der[4 + rLength + 1] ?? 0];
}

describe('secp256k1SpkiToAddress', () => {
  it('derives the same address as viem does from the private key', () => {
    const { spki, key } = nodeKey();

    expect(secp256k1SpkiToAddress(spki)).toBe(privateKeyToAddress(toHex(key)));
  });

  it('rejects a P-256 public key', () => {
    expect(() => secp256k1SpkiToAddress(nodeKey('prime256v1').spki)).toThrow(
      'the public key is not an uncompressed secp256k1 SubjectPublicKeyInfo',
    );
  });

  it("rejects a secp256k1 point under another curve's OID", () => {
    const spki = nodeKey().spki;
    spki[19] = 0x0b; // the curve OID's last byte: 1.3.132.0.10 becomes 1.3.132.0.11

    expect(() => secp256k1SpkiToAddress(spki)).toThrow('not an uncompressed secp256k1');
  });
});

describe('ed25519SpkiToAddress', () => {
  it('derives the same address as @solana/web3.js does from the seed', () => {
    const { spki, seed } = nodeEd25519Key();

    expect(ed25519SpkiToAddress(spki)).toBe(Keypair.fromSeed(seed).publicKey.toBase58());
  });

  it.each([
    ['a secp256k1 public key', () => nodeKey().spki],
    [
      'an X25519 public key',
      () => {
        const { publicKey } = generateKeyPairSync('x25519');
        return new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
      },
    ],
    ['a truncated key', () => nodeEd25519Key().spki.subarray(0, 43)],
    ['trailing bytes', () => Uint8Array.from([...nodeEd25519Key().spki, 0])],
  ])('rejects %s', (_, spki) => {
    expect(() => ed25519SpkiToAddress(spki())).toThrow(
      'the public key is not an Ed25519 SubjectPublicKeyInfo',
    );
  });
});

describe('createAwsKmsBackend', () => {
  it("returns the key's address", async () => {
    const { address, api } = kmsKey();

    expect(await createAwsKmsBackend(api).address('secp256k1', KEY_ID)).toBe(address);
    expect(api.publicKey).toHaveBeenCalledWith(KEY_ID);
  });

  it('signs the digest and returns r || s with the recovery bit appended', async () => {
    const { key, api } = kmsKey();
    const digest = randomBytes(32);

    const signature = await createAwsKmsBackend(api).sign('secp256k1', KEY_ID, digest);

    expect(api.signDigest).toHaveBeenCalledWith(KEY_ID, digest);
    expect(signature).toEqual(expectedSignature(key, digest));
  });

  it.each([
    ['r is padded with a leading 0x00', (r: bigint) => r >= 2n ** 255n, 33, undefined],
    ['r is a short, 31-byte integer', (r: bigint) => r < 2n ** 247n, 31, undefined],
    ['s is a short, 31-byte integer', (_: bigint, s: bigint) => s < 2n ** 247n, undefined, 31],
  ] as const)('parses a DER signature where %s', async (_, shape, rLength, sLength) => {
    const { key, api } = kmsKey();
    const digest = digestWhere(key, shape);
    const der = secp256k1.sign(digest, key, { prehash: false, format: 'der' });
    const [r, s] = derIntegerLengths(der);
    if (rLength) expect(r).toBe(rLength);
    if (sLength) expect(s).toBe(sLength);

    expect(await createAwsKmsBackend(api).sign('secp256k1', KEY_ID, digest)).toEqual(
      expectedSignature(key, digest),
    );
  });

  it('lowers a high s, whose DER integer is padded, and still finds the recovery bit', async () => {
    const { key, api } = kmsKey((der) => {
      const { r, s } = secp256k1.Signature.fromBytes(der, 'der');
      return new secp256k1.Signature(r, N - s).toBytes('der');
    });
    const digest = randomBytes(32);

    expect(await createAwsKmsBackend(api).sign('secp256k1', KEY_ID, digest)).toEqual(
      expectedSignature(key, digest),
    );
  });

  it.each([
    ['trailing bytes', '3006020101020101ff'],
    ['a truncated integer', '30060201010201'],
    ['an unnecessary leading zero', '300702020001020101'],
    ['a negative integer', '3006020180020101'],
    ['not a SEQUENCE', '3106020101020101'],
    ['raw r || s instead of DER', 'ab'.repeat(64)],
  ])('rejects a DER signature with %s', async (_, hex) => {
    const { api } = kmsKey(() => Buffer.from(hex, 'hex'));

    await expect(
      createAwsKmsBackend(api).sign('secp256k1', KEY_ID, randomBytes(32)),
    ).rejects.toThrow('KMS returned a malformed DER signature');
  });

  it("rejects a signature that isn't the key's", async () => {
    const other = nodeKey().key;
    const { address, api } = kmsKey();
    api.signDigest = (_keyId, digest) =>
      Promise.resolve(secp256k1.sign(digest, other, { prehash: false, format: 'der' }));

    await expect(
      createAwsKmsBackend(api).sign('secp256k1', KEY_ID, randomBytes(32)),
    ).rejects.toThrow(`the signature does not recover to ${address}`);
  });

  it("returns an Ed25519 key's Solana address", async () => {
    const { address, api } = kmsEd25519Key();

    expect(await createAwsKmsBackend(api).address('ed25519', KEY_ID)).toBe(address);
  });

  it('signs the message itself with Ed25519 and returns the signature unchanged', async () => {
    const { seed, api } = kmsEd25519Key();
    const message = randomBytes(300);

    const signature = await createAwsKmsBackend(api).sign('ed25519', KEY_ID, message);

    expect(api.signRaw).toHaveBeenCalledWith(KEY_ID, message);
    expect(signature).toEqual(ed25519.sign(message, seed));
  });

  it("rejects an Ed25519 signature that isn't the key's", async () => {
    const other = nodeEd25519Key().seed;
    const { address, api } = kmsEd25519Key();
    api.signRaw = (_keyId, message) => Promise.resolve(ed25519.sign(message, other));

    await expect(
      createAwsKmsBackend(api).sign('ed25519', KEY_ID, randomBytes(300)),
    ).rejects.toThrow(`KMS's signature does not verify for ${address} over the message`);
  });

  it('rejects an Ed25519 signature over another message', async () => {
    const { address, api } = kmsEd25519Key();
    const signRaw = api.signRaw;
    api.signRaw = (keyId) => signRaw(keyId, randomBytes(300));

    await expect(
      createAwsKmsBackend(api).sign('ed25519', KEY_ID, randomBytes(300)),
    ).rejects.toThrow(`KMS's signature does not verify for ${address} over the message`);
  });

  it.each([
    ['DER-wrapped', (sig: Uint8Array) => Uint8Array.from([0x30, 0x44, 0x04, 0x40, ...sig]), 68],
    ['truncated', (sig: Uint8Array) => sig.subarray(0, 63), 63],
  ])('rejects an Ed25519 signature that is %s', async (_, transform, length) => {
    const { api } = kmsEd25519Key(transform);

    await expect(
      createAwsKmsBackend(api).sign('ed25519', KEY_ID, randomBytes(300)),
    ).rejects.toThrow(`KMS returned a ${length}-byte Ed25519 signature; it must be 64 bytes`);
  });

  it.each([
    ['a secp256k1 key for ed25519', kmsKey, 'ed25519', 'ECC_SECG_P256K1', 'ECC_NIST_EDWARDS25519'],
    [
      'an Ed25519 key for secp256k1',
      kmsEd25519Key,
      'secp256k1',
      'ECC_NIST_EDWARDS25519',
      'ECC_SECG_P256K1',
    ],
  ] as const)(
    'refuses %s, naming both key specs, without signing',
    async (_, key, curve, actual, expected) => {
      const { api } = key();
      const backend = createAwsKmsBackend(api);
      const message = `KMS key ${KEY_ID} is ${actual} for SIGN_VERIFY; it must be ${expected} for SIGN_VERIFY`;

      await expect(backend.address(curve, KEY_ID)).rejects.toThrow(message);
      await expect(backend.sign(curve, KEY_ID, randomBytes(32))).rejects.toThrow(message);
      expect(api.signDigest).not.toHaveBeenCalled();
      expect(api.signRaw).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['an encryption key', 'ENCRYPT_DECRYPT'],
    ['a key with no usage', undefined],
  ])('refuses %s, naming it', async (_, keyUsage) => {
    const { api } = kmsEd25519Key();
    const publicKey = api.publicKey;
    api.publicKey = async (keyId) => ({ ...(await publicKey(keyId)), keyUsage });

    await expect(createAwsKmsBackend(api).address('ed25519', KEY_ID)).rejects.toThrow(
      `KMS key ${KEY_ID} is ECC_NIST_EDWARDS25519 for ${keyUsage}; it must be ECC_NIST_EDWARDS25519 for SIGN_VERIFY`,
    );
  });

  it('fetches the public key once, however many times it signs', async () => {
    const { api } = kmsKey();
    const backend = createAwsKmsBackend(api);

    await backend.address('secp256k1', KEY_ID);
    await backend.sign('secp256k1', KEY_ID, randomBytes(32));
    await backend.sign('secp256k1', KEY_ID, randomBytes(32));

    expect(api.publicKey).toHaveBeenCalledOnce();
  });

  it('fetches the public key again after a failed lookup', async () => {
    const { address, api } = kmsKey();
    const lookup = api.publicKey;
    api.publicKey = vi
      .fn()
      .mockRejectedValueOnce(new Error('KMS is down'))
      .mockImplementation(lookup);
    const backend = createAwsKmsBackend(api);

    await expect(backend.address('secp256k1', KEY_ID)).rejects.toThrow('KMS is down');
    await expect(backend.address('secp256k1', KEY_ID)).resolves.toBe(address);
  });
});

describe('createKmsApi', () => {
  function sdkStub(publicKey: Record<string, unknown> = {}) {
    const send = vi.fn((command: GetPublicKeyCommand | SignCommand) =>
      Promise.resolve(
        command instanceof GetPublicKeyCommand
          ? {
              KeySpec: 'ECC_SECG_P256K1',
              KeyUsage: 'SIGN_VERIFY',
              PublicKey: Uint8Array.of(1, 2),
              ...publicKey,
            }
          : { Signature: Uint8Array.of(3, 4) },
      ),
    );
    return { sdk: { send } as unknown as KmsSdk, send };
  }

  it("asks for the key's public key and returns it with its key spec and usage", async () => {
    const { sdk, send } = sdkStub();

    expect(await createKmsApi(sdk).publicKey(KEY_ID)).toStrictEqual({
      spki: Uint8Array.of(1, 2),
      keySpec: 'ECC_SECG_P256K1',
      keyUsage: 'SIGN_VERIFY',
    });
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(GetPublicKeyCommand);
    expect(command?.input).toStrictEqual({ KeyId: KEY_ID });
  });

  it('signs the digest as given, with ECDSA_SHA_256, and returns the signature', async () => {
    const { sdk, send } = sdkStub();
    const digest = randomBytes(32);

    expect(await createKmsApi(sdk).signDigest(KEY_ID, digest)).toEqual(Uint8Array.of(3, 4));
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SignCommand);
    expect(command?.input).toStrictEqual({
      KeyId: KEY_ID,
      Message: digest,
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    });
  });

  it('signs the message itself with pure Ed25519 (RAW, ED25519_SHA_512) and returns the signature', async () => {
    const { sdk, send } = sdkStub();
    const message = randomBytes(300);

    expect(await createKmsApi(sdk).signRaw(KEY_ID, message)).toEqual(Uint8Array.of(3, 4));
    const command = send.mock.calls[0]?.[0];
    expect(command).toBeInstanceOf(SignCommand);
    expect(command?.input).toStrictEqual({
      KeyId: KEY_ID,
      Message: message,
      MessageType: 'RAW',
      SigningAlgorithm: 'ED25519_SHA_512',
    });
  });

  it('refuses a key with no public key', async () => {
    const { sdk } = sdkStub({ PublicKey: undefined });

    await expect(createKmsApi(sdk).publicKey(KEY_ID)).rejects.toThrow(
      `KMS returned no public key for ${KEY_ID}`,
    );
  });
});

describe('createBackends for aws-kms', () => {
  it('builds a real KMS client from no Signer variables', () => {
    expect(createBackends(['aws-kms'], {}).has('aws-kms')).toBe(true);
  });
});
