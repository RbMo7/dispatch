import { readFileSync } from 'node:fs';

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import bs58 from 'bs58';
import { privateKeyToAddress } from 'viem/accounts';

import type { Curve, KeyBackend } from './key-backend.js';

/** curve -> keyRef -> 32-byte private key, hex-encoded. */
type Keyfile = Record<Curve, Record<string, string>>;

function addressOf(curve: Curve, key: Uint8Array): string {
  switch (curve) {
    case 'secp256k1':
      return privateKeyToAddress(`0x${Buffer.from(key).toString('hex')}`);
    case 'ed25519':
      return bs58.encode(ed25519.getPublicKey(key));
  }
}

function signWith(curve: Curve, key: Uint8Array, payload: Uint8Array): Uint8Array {
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

/** Runs `fn` so that a throw becomes a rejection, as a caller of an async backend expects. */
function settle<T>(fn: () => T): Promise<T> {
  return new Promise((resolve) => resolve(fn()));
}

/**
 * Keys read from a JSON file into process memory. For development only:
 * anyone who can read the file or the process has the keys.
 */
export function createKeyfileBackend(
  path: string,
  warn: (message: string) => void = (message) => console.error(message),
): KeyBackend {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Keyfile>;
  const keyfile: Keyfile = { secp256k1: raw.secp256k1 ?? {}, ed25519: raw.ed25519 ?? {} };
  warn(
    `WARNING: the keyfile backend holds raw private keys from ${path} in memory. ` +
      'It is for development only; never use it for real funds.',
  );

  function privateKey(curve: Curve, keyRef: string): Uint8Array {
    const hex = keyfile[curve][keyRef];
    if (hex === undefined) throw new Error(`the keyfile has no ${curve} key "${keyRef}"`);
    const bytes = Buffer.from(hex, 'hex');
    if (bytes.length !== 32) {
      throw new Error(`${curve} key "${keyRef}" is not a 32-byte hex private key`);
    }
    return bytes;
  }

  return {
    address: (curve, keyRef) => settle(() => addressOf(curve, privateKey(curve, keyRef))),
    sign: (curve, keyRef, payload) =>
      settle(() => signWith(curve, privateKey(curve, keyRef), payload)),
  };
}
