import { createPrivateKey, sign as nodeSign } from 'node:crypto';

import { secp256k1 } from '@noble/curves/secp256k1.js';

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
 * Signs an already-computed 32-byte digest directly (`prehash: false`) —
 * never re-hashing it — and returns the 65-byte "recovered" encoding
 * (`r`(32) || `s`(32) || recovery-byte(1)), canonical low-S by default.
 * Ethereum-shaped callers (base-chain-handler) hand this exactly their own
 * EIP-1559 signing hash (keccak256 of the RLP payload) and need the
 * recovery byte back to derive `v`/`yParity` and let the sender address be
 * recovered on-chain — a bare r||s pair without it isn't enough to build a
 * valid Ethereum signed transaction. Uses `@noble/curves` (a
 * dependency-free elliptic-curve library, the same one `viem` itself uses)
 * rather than Node's built-in crypto: Node has no supported way to sign a
 * pre-computed digest under secp256k1 without either re-hashing it or
 * losing the recovery id.
 */
function signSecp256k1(privateKeyHex: string, digest: Buffer): Buffer {
  const scalar = privateKeyBytes(privateKeyHex);
  if (digest.length !== 32) {
    throw new Error(`secp256k1 signing expects a 32-byte digest, got ${digest.length} bytes`);
  }
  const signature = secp256k1.sign(digest, scalar, { prehash: false, format: 'recovered' });
  return Buffer.from(signature);
}

/**
 * Signs raw message bytes under the given curve, using only dependency-free
 * cryptography (no signing vendor SDK, per ADR-0002's spirit even for this
 * reference implementation). ed25519 signs the bytes directly, matching
 * Solana's own signing model; secp256k1 signs `message` as an
 * already-final digest with no additional hashing, matching Ethereum's own
 * signing model, and returns a recoverable signature (see
 * `signSecp256k1`'s own doc comment).
 */
export function sign(curve: Curve, privateKeyHex: string, message: Buffer): Buffer {
  switch (curve) {
    case 'ed25519':
      return signEd25519(privateKeyHex, message);
    case 'secp256k1':
      return signSecp256k1(privateKeyHex, message);
  }
}
