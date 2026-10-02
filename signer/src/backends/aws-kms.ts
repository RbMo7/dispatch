import {
  GetPublicKeyCommand,
  SignCommand,
  type GetPublicKeyCommandOutput,
  type SignCommandOutput,
} from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes, toHex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

import type { KeyBackend } from './key-backend.js';
import { recoverableSignature } from './secp256k1-recovery.js';

/** The two KMS calls the backend makes, so tests can stand in for KMS. */
export type KmsApi = {
  /** The key's public key as a DER SubjectPublicKeyInfo. */
  publicKey: (keyId: string) => Promise<Uint8Array>;
  /** Signs a 32-byte digest as given; returns a DER ECDSA signature. */
  signDigest: (keyId: string, digest: Uint8Array) => Promise<Uint8Array>;
};

/** The slice of the AWS SDK's `KMSClient` that `createKmsApi` calls. */
export type KmsSdk = {
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>;
  send(command: SignCommand): Promise<SignCommandOutput>;
};

/** The AWS SDK as a `KmsApi`. Refuses a key that isn't a secp256k1 signing key. */
export function createKmsApi(sdk: KmsSdk): KmsApi {
  return {
    async publicKey(keyId) {
      const { KeySpec, KeyUsage, PublicKey } = await sdk.send(
        new GetPublicKeyCommand({ KeyId: keyId }),
      );
      if (KeySpec !== 'ECC_SECG_P256K1' || KeyUsage !== 'SIGN_VERIFY') {
        throw new Error(
          `KMS key ${keyId} is ${KeySpec} for ${KeyUsage}; it must be ECC_SECG_P256K1 for SIGN_VERIFY`,
        );
      }
      if (!PublicKey) throw new Error(`KMS returned no public key for ${keyId}`);
      return PublicKey;
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
  };
}

/**
 * Every uncompressed secp256k1 SubjectPublicKeyInfo starts with these bytes:
 * the algorithm (id-ecPublicKey, secp256k1) and the BIT STRING's header. The
 * 65-byte point follows.
 */
const SECP256K1_SPKI_PREFIX = hexToBytes('0x3056301006072a8648ce3d020106052b8104000a034200');

/** The EVM address of a DER SubjectPublicKeyInfo holding an uncompressed secp256k1 key. */
export function spkiToAddress(spki: Uint8Array): string {
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
 * secp256k1 only. Every signature is checked against the key's address
 * before it is returned.
 */
export function createAwsKmsBackend(api: KmsApi): KeyBackend {
  const addresses = new Map<string, Promise<string>>();
  function keyAddress(keyId: string): Promise<string> {
    let address = addresses.get(keyId);
    if (!address) {
      address = api.publicKey(keyId).then(spkiToAddress);
      // A failed lookup is retried next time rather than cached.
      address.catch(() => addresses.delete(keyId));
      addresses.set(keyId, address);
    }
    return address;
  }

  return {
    async address(curve, keyId) {
      if (curve !== 'secp256k1') throw new Error('aws-kms supports secp256k1 only; see #51');
      return keyAddress(keyId);
    },
    async sign(curve, keyId, digest) {
      if (curve !== 'secp256k1') throw new Error('aws-kms supports secp256k1 only; see #51');
      const address = await keyAddress(keyId);
      const der = await api.signDigest(keyId, digest);
      return recoverableSignature(derToCompact(der), digest, address);
    },
  };
}
