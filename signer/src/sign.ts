import { createPrivateKey, sign as nodeSign } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';

/** Mirrors src/domain/curve.ts on the engine side — kept separate since this package must stay outside the engine's dependency tree (ADR-0002). */
export type Curve = 'secp256k1' | 'ed25519';

// RFC 8410 PKCS8 wrapper for a raw 32-byte Ed25519 seed: SEQUENCE { version 0,
// AlgorithmIdentifier{id-Ed25519}, OCTET STRING(OCTET STRING(seed)) }.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function privateKeyBytes(privateKeyHex: string): Buffer {
  const bytes = Buffer.from(privateKeyHex, 'hex');
  if (bytes.length !== 32) {
    throw new Error(`expected a 32-byte private key, got ${bytes.length} bytes`);
  }
  return bytes;
}

function signEd25519(privateKeyHex: string, message: Buffer): Buffer {
  const seed = privateKeyBytes(privateKeyHex);
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return nodeSign(null, message, key);
}

/**
 * Signs a 32-byte digest directly (`prehash: false`), never re-hashing it,
 * and returns a 65-byte `r`(32) || `s`(32) || recovery-byte(1) encoding,
 * canonical low-S by default. The recovery byte lets the engine derive
 * `yParity` and recover the Sender's address; a bare r||s pair isn't
 * enough to build a valid Ethereum signed transaction.
 *
 * `@noble/curves`'s own `format: 'recovered'` puts the recovery byte
 * *first* (`recovery || r || s`) — confirmed against its source, not
 * assumed. That ordering is an implementation detail of this library, not
 * a standard this wire contract should leak, so it's reordered here to the
 * conventional r||s||recovery layout any Ethereum-familiar reader expects.
 *
 * Uses `@noble/curves` (a dependency-free elliptic-curve library, the same
 * one `viem` itself uses) rather than Node's built-in crypto: Node has no
 * supported way to sign a pre-computed digest under secp256k1 without
 * either re-hashing it or losing the recovery id.
 */
function signSecp256k1(privateKeyHex: string, digest: Uint8Array): Buffer {
  const scalar = privateKeyBytes(privateKeyHex);
  const signature = secp256k1.sign(digest, scalar, { prehash: false, format: 'recovered' });
  const recovery = signature[0];
  const r = signature.slice(1, 33);
  const s = signature.slice(33, 65);
  return Buffer.concat([r, s, Buffer.from([recovery ?? 0])]);
}

/**
 * Signs a chain's whole unsigned transaction under the given curve (ADR-0046),
 * using only dependency-free cryptography (no signing vendor SDK, per
 * ADR-0002's spirit even for this reference implementation). ed25519 signs
 * the bytes directly: on Solana they are the message itself. secp256k1
 * treats them as an unsigned EIP-1559 serialization (`0x02 || rlp(...)`)
 * and signs its keccak256, Ethereum's signing hash, returning a recoverable
 * signature (see `signSecp256k1`).
 */
export function sign(curve: Curve, privateKeyHex: string, unsignedTransaction: Buffer): Buffer {
  switch (curve) {
    case 'ed25519':
      return signEd25519(privateKeyHex, unsignedTransaction);
    case 'secp256k1':
      return signSecp256k1(privateKeyHex, keccak_256(unsignedTransaction));
  }
}
