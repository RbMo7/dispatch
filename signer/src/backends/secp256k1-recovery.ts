import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToBigInt, toHex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

const N = secp256k1.Point.CURVE().n;

function recoversTo(
  r: bigint,
  s: bigint,
  recovery: number,
  digest: Uint8Array,
): string | undefined {
  try {
    const publicKey = new secp256k1.Signature(r, s, recovery).recoverPublicKey(digest);
    return publicKeyToAddress(toHex(publicKey.toBytes(false)));
  } catch {
    return undefined;
  }
}

/**
 * Turns an ECDSA signature from a key store that doesn't return Ethereum's
 * form into the wire's 65-byte `r || s || recovery`: a high `s` is lowered
 * to `n - s` (EIP-2), and the recovery bit is whichever one recovers
 * `address` over `digest`. Takes `r || s`, or `r || s || v` with `v`
 * ignored, since stores disagree on how they encode it. Throws when neither
 * bit recovers `address`: the signature is not that key's over that digest.
 */
export function recoverableSignature(
  signature: Uint8Array,
  digest: Uint8Array,
  address: string,
): Uint8Array {
  if (signature.length !== 64 && signature.length !== 65) {
    throw new Error(`expected a 64- or 65-byte secp256k1 signature, got ${signature.length} bytes`);
  }
  const r = bytesToBigInt(signature.subarray(0, 32));
  const highS = bytesToBigInt(signature.subarray(32, 64));
  const s = highS > N / 2n ? N - highS : highS;

  for (const recovery of [0, 1]) {
    if (recoversTo(r, s, recovery, digest)?.toLowerCase() === address.toLowerCase()) {
      return Uint8Array.from([...new secp256k1.Signature(r, s).toBytes('compact'), recovery]);
    }
  }
  throw new Error(`the signature does not recover to ${address}`);
}
