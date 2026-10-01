import { readFileSync } from 'node:fs';

import type { Curve } from './sign.js';

/** curve -> address -> 32-byte private key, hex-encoded. */
export type Keyring = Record<Curve, Record<string, string>>;

export function loadKeyring(path: string): Keyring {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<Keyring>;
  return {
    secp256k1: raw.secp256k1 ?? {},
    ed25519: raw.ed25519 ?? {},
  };
}
