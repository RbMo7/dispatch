import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import {
  createAwsKmsBackend,
  createKmsApi,
  spkiToAddress,
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
    publicKey: vi.fn(() => Promise.resolve(spki)),
    signDigest: vi.fn((_keyId: string, digest: Uint8Array) =>
      Promise.resolve(transform(secp256k1.sign(digest, key, { prehash: false, format: 'der' }))),
    ),
  };
  return { key, address: privateKeyToAddress(toHex(key)), api };
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

describe('spkiToAddress', () => {
  it('derives the same address as viem does from the private key', () => {
    const { spki, key } = nodeKey();

    expect(spkiToAddress(spki)).toBe(privateKeyToAddress(toHex(key)));
  });

  it('rejects a P-256 public key', () => {
    expect(() => spkiToAddress(nodeKey('prime256v1').spki)).toThrow(
      'the public key is not an uncompressed secp256k1 SubjectPublicKeyInfo',
    );
  });

  it("rejects a secp256k1 point under another curve's OID", () => {
    const spki = nodeKey().spki;
    spki[19] = 0x0b; // the curve OID's last byte: 1.3.132.0.10 becomes 1.3.132.0.11

    expect(() => spkiToAddress(spki)).toThrow('not an uncompressed secp256k1');
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

  it('refuses ed25519 without asking KMS', async () => {
    const { api } = kmsKey();
    const backend = createAwsKmsBackend(api);

    await expect(backend.address('ed25519', KEY_ID)).rejects.toThrow(
      'aws-kms supports secp256k1 only; see #51',
    );
    await expect(backend.sign('ed25519', KEY_ID, randomBytes(32))).rejects.toThrow(
      'aws-kms supports secp256k1 only; see #51',
    );
    expect(api.publicKey).not.toHaveBeenCalled();
    expect(api.signDigest).not.toHaveBeenCalled();
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

  it("asks for the key's public key and returns it", async () => {
    const { sdk, send } = sdkStub();

    expect(await createKmsApi(sdk).publicKey(KEY_ID)).toEqual(Uint8Array.of(1, 2));
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

  it.each([
    ['a P-256 key', { KeySpec: 'ECC_NIST_P256' }, 'ECC_NIST_P256 for SIGN_VERIFY'],
    ['an encryption key', { KeyUsage: 'ENCRYPT_DECRYPT' }, 'ECC_SECG_P256K1 for ENCRYPT_DECRYPT'],
  ])('refuses %s, naming it', async (_, publicKey, described) => {
    const { sdk } = sdkStub(publicKey);

    await expect(createKmsApi(sdk).publicKey(KEY_ID)).rejects.toThrow(
      `KMS key ${KEY_ID} is ${described}; it must be ECC_SECG_P256K1 for SIGN_VERIFY`,
    );
  });
});

describe('createBackends for aws-kms', () => {
  it('builds a real KMS client from no Signer variables', () => {
    expect(createBackends(['aws-kms'], {}).has('aws-kms')).toBe(true);
  });
});
