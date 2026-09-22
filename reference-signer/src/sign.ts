import { createPrivateKey, sign as nodeSign } from 'node:crypto';

/** Mirrors src/domain/curve.ts on the engine side — kept separate since this package must stay outside the engine's dependency tree (ADR-0002). */
export type Curve = 'secp256k1' | 'ed25519';

// RFC 8410 PKCS8 wrapper for a raw 32-byte Ed25519 seed: SEQUENCE { version 0,
// AlgorithmIdentifier{id-Ed25519}, OCTET STRING(OCTET STRING(seed)) }.
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// DER OID 1.3.132.0.10 (secp256k1).
const SECP256K1_OID = Buffer.from('06052b8104000a', 'hex');

function derLength(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.concat([Buffer.from([0x80 | bytes.length]), Buffer.from(bytes)]);
}

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

function signSecp256k1(privateKeyHex: string, message: Buffer): Buffer {
  const scalar = privateKeyBytes(privateKeyHex);

  // SEC1 ECPrivateKey ::= SEQUENCE { version 1, privateKey OCTET STRING,
  // parameters [0] EXPLICIT OID }. The public key field is optional and
  // omitted here — Node/OpenSSL derives it from the scalar as needed.
  const params = Buffer.concat([
    Buffer.from([0xa0]),
    derLength(SECP256K1_OID.length),
    SECP256K1_OID,
  ]);
  const version = Buffer.from([0x02, 0x01, 0x01]);
  const privateKeyField = Buffer.concat([Buffer.from([0x04]), derLength(scalar.length), scalar]);
  const inner = Buffer.concat([version, privateKeyField, params]);
  const der = Buffer.concat([Buffer.from([0x30]), derLength(inner.length), inner]);

  const key = createPrivateKey({ key: der, format: 'der', type: 'sec1' });
  return nodeSign('sha256', message, { key, dsaEncoding: 'ieee-p1363' });
}

/**
 * Signs raw message bytes under the given curve, using only Node's built-in
 * crypto (no signing SDK, per ADR-0002's spirit even for this reference
 * implementation). ed25519 signs the bytes directly, matching Solana's own
 * signing model; secp256k1 signs their sha256 digest and returns a raw
 * fixed-length r||s signature — no Ethereum-style recovery id, since no EVM
 * Chain Handler consumes this yet.
 */
export function sign(curve: Curve, privateKeyHex: string, message: Buffer): Buffer {
  switch (curve) {
    case 'ed25519':
      return signEd25519(privateKeyHex, message);
    case 'secp256k1':
      return signSecp256k1(privateKeyHex, message);
  }
}
