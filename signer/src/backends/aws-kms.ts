import {
  GetPublicKeyCommand,
  SignCommand,
  type GetPublicKeyCommandOutput,
  type SignCommandOutput,
} from '@aws-sdk/client-kms';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import bs58 from 'bs58';
import { bytesToHex, hexToBytes, toHex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

import type { Curve, KeyBackend } from './key-backend.js';
import { recoverableSignature } from './secp256k1-recovery.js';

/** A key's public half as `GetPublicKey` describes it. */
export type KmsPublicKey = {
  /** A DER SubjectPublicKeyInfo. */
  spki: Uint8Array;
  keySpec: string | undefined;
  keyUsage: string | undefined;
};

/** The KMS calls the backend makes, so tests can stand in for KMS. */
export type KmsApi = {
  publicKey: (keyId: string) => Promise<KmsPublicKey>;
  /** Signs a 32-byte digest as given (ECDSA); returns a DER ECDSA signature. */
  signDigest: (keyId: string, digest: Uint8Array) => Promise<Uint8Array>;
  /** Signs the message itself with pure Ed25519; returns the signature as KMS gives it. */
  signRaw: (keyId: string, message: Uint8Array) => Promise<Uint8Array>;
};

/** The slice of the AWS SDK's `KMSClient` that `createKmsApi` calls. */
export type KmsSdk = {
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>;
  send(command: SignCommand): Promise<SignCommandOutput>;
};

/** The AWS SDK as a `KmsApi`. */
export function createKmsApi(sdk: KmsSdk): KmsApi {
  return {
    async publicKey(keyId) {
      const { KeySpec, KeyUsage, PublicKey } = await sdk.send(
        new GetPublicKeyCommand({ KeyId: keyId }),
      );
      if (!PublicKey) throw new Error(`KMS returned no public key for ${keyId}`);
      return { spki: PublicKey, keySpec: KeySpec, keyUsage: KeyUsage };
    },
    async signDigest(keyId, digest) {
      const { Signature } = await sdk.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          // DIGEST: KMS signs the keccak256 digest as given rather than hashing it again with SHA-256.
          MessageType: 'DIGEST',
          SigningAlgorithm: 'ECDSA_SHA_256',
        }),
      );
      if (!Signature) throw new Error(`KMS returned no signature for ${keyId}`);
      return Signature;
    },
    async signRaw(keyId, message) {
      const { Signature } = await sdk.send(
        new SignCommand({
          KeyId: keyId,
          Message: message,
          // Pure Ed25519 (RFC 8032), which Solana verifies. ED25519_PH_SHA_512 is HashEdDSA, whose signatures Solana rejects.
          MessageType: 'RAW',
          SigningAlgorithm: 'ED25519_SHA_512',
        }),
      );
      if (!Signature) throw new Error(`KMS returned no signature for ${keyId}`);
      return Signature;
    },
  };
}

/**
 * Every uncompressed secp256k1 SubjectPublicKeyInfo starts with these bytes:
 * the algorithm (id-ecPublicKey, secp256k1) and the BIT STRING's header. The
 * 65-byte point follows.
 */
const SECP256K1_SPKI_PREFIX = hexToBytes('0x3056301006072a8648ce3d020106052b8104000a034200');

/** The EVM address of a DER SubjectPublicKeyInfo holding an uncompressed secp256k1 key. */
export function secp256k1SpkiToAddress(spki: Uint8Array): string {
  const prefix = spki.subarray(0, SECP256K1_SPKI_PREFIX.length);
  if (
    spki.length !== SECP256K1_SPKI_PREFIX.length + 65 ||
    bytesToHex(prefix) !== bytesToHex(SECP256K1_SPKI_PREFIX)
  ) {
    throw new Error('the public key is not an uncompressed secp256k1 SubjectPublicKeyInfo');
  }
  const point = secp256k1.Point.fromBytes(spki.subarray(SECP256K1_SPKI_PREFIX.length));
  return publicKeyToAddress(toHex(point.toBytes(false)));
}

/**
 * Every Ed25519 SubjectPublicKeyInfo (RFC 8410) starts with these bytes: the
 * algorithm (id-Ed25519, 1.3.101.112) and the BIT STRING's header. The
 * 32-byte public key follows.
 */
const ED25519_SPKI_PREFIX = hexToBytes('0x302a300506032b6570032100');

/** The base58 Solana address of a DER SubjectPublicKeyInfo holding an Ed25519 key. */
export function ed25519SpkiToAddress(spki: Uint8Array): string {
  const prefix = spki.subarray(0, ED25519_SPKI_PREFIX.length);
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + 32 ||
    bytesToHex(prefix) !== bytesToHex(ED25519_SPKI_PREFIX)
  ) {
    throw new Error('the public key is not an Ed25519 SubjectPublicKeyInfo');
  }
  return bs58.encode(spki.subarray(ED25519_SPKI_PREFIX.length));
}

/** What a KMS key must be to sign for each curve, and how its public key becomes an address. */
const CURVE_KEYS: Record<Curve, { keySpec: string; toAddress: (spki: Uint8Array) => string }> = {
  secp256k1: { keySpec: 'ECC_SECG_P256K1', toAddress: secp256k1SpkiToAddress },
  ed25519: { keySpec: 'ECC_NIST_EDWARDS25519', toAddress: ed25519SpkiToAddress },
};

function addressFor(curve: Curve, keyId: string, publicKey: KmsPublicKey): string {
  const { keySpec, toAddress } = CURVE_KEYS[curve];
  if (publicKey.keySpec !== keySpec || publicKey.keyUsage !== 'SIGN_VERIFY') {
    throw new Error(
      `KMS key ${keyId} is ${publicKey.keySpec} for ${publicKey.keyUsage}; it must be ${keySpec} for SIGN_VERIFY`,
    );
  }
  return toAddress(publicKey.spki);
}

function derToCompact(der: Uint8Array): Uint8Array {
  try {
    return secp256k1.Signature.fromBytes(der, 'der').toBytes('compact');
  } catch (cause) {
    throw new Error(
      `KMS returned a malformed DER signature: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Keys held in AWS KMS; `keyRef` is the key id, key ARN or alias ARN.
 * Every signature is checked against the key's address before it is
 * returned.
 */
export function createAwsKmsBackend(api: KmsApi): KeyBackend {
  const publicKeys = new Map<string, Promise<KmsPublicKey>>();
  function publicKey(keyId: string): Promise<KmsPublicKey> {
    let key = publicKeys.get(keyId);
    if (!key) {
      key = api.publicKey(keyId);
      // A failed lookup is retried next time rather than cached.
      key.catch(() => publicKeys.delete(keyId));
      publicKeys.set(keyId, key);
    }
    return key;
  }
  const keyAddress = async (curve: Curve, keyId: string) =>
    addressFor(curve, keyId, await publicKey(keyId));

  return {
    address: keyAddress,
    async sign(curve, keyId, payload) {
      const address = await keyAddress(curve, keyId);
      switch (curve) {
        case 'secp256k1': {
          const der = await api.signDigest(keyId, payload);
          return recoverableSignature(derToCompact(der), payload, address);
        }
        case 'ed25519': {
          const signature = await api.signRaw(keyId, payload);
          if (signature.length !== 64) {
            throw new Error(
              `KMS returned a ${signature.length}-byte Ed25519 signature; it must be 64 bytes`,
            );
          }
          if (!ed25519.verify(signature, payload, bs58.decode(address))) {
            throw new Error(`KMS's signature does not verify for ${address} over the message`);
          }
          return signature;
        }
      }
    },
  };
}
