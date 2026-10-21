import { readFileSync } from 'node:fs';

import type { Curve, KeyBackend } from './key-backend.js';
import { addressOf, signWith } from './raw-key.js';

/** curve -> keyRef -> 32-byte private key, hex-encoded. */
type Keyfile = Record<Curve, Record<string, string>>;

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
