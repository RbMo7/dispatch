import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import bs58 from 'bs58';
import { privateKeyToAddress } from 'viem/accounts';

import type { Curve } from './key-backend.js';

/** Raw 32-byte private keys, for the backends that hold them in process memory (`keyfile`, `local`). */
export function addressOf(curve: Curve, key: Uint8Array): string {
  switch (curve) {
    case 'secp256k1':
      return privateKeyToAddress(`0x${Buffer.from(key).toString('hex')}`);
    case 'ed25519':
      return bs58.encode(ed25519.getPublicKey(key));
  }
}

export function signWith(curve: Curve, key: Uint8Array, payload: Uint8Array): Uint8Array {
  switch (curve) {
    case 'secp256k1': {
      // noble's 'recovered' format puts the recovery byte first; the wire
      // contract puts it last.
      const signature = secp256k1.sign(payload, key, { prehash: false, format: 'recovered' });
      return Uint8Array.from([...signature.subarray(1), signature[0] ?? 0]);
    }
    case 'ed25519':
      return ed25519.sign(payload, key);
  }
}
