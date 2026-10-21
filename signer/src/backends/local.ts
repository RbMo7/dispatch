import { readFileSync, statSync } from 'node:fs';

import type { Curve, KeyBackend } from './key-backend.js';
import { decryptKey, KeystoreError, readKeyFile } from './keystore.js';
import { signWith } from './raw-key.js';

type Env = Record<string, string | undefined>;

export function keystoreDir(env: Env): string {
  const dir = env.SIGNER_KEYSTORE_DIR;
  if (dir === undefined || dir === '') {
    throw new KeystoreError('SIGNER_KEYSTORE_DIR is required by the local backend');
  }
  return dir;
}

/**
 * The passphrase, from SIGNER_KEYSTORE_PASSPHRASE or the file named by
 * SIGNER_KEYSTORE_PASSPHRASE_FILE (a mounted secret), never an argument. A
 * file's one trailing newline is dropped; nothing else is trimmed.
 */
export function keystorePassphrase(env: Env): string {
  const inline = env.SIGNER_KEYSTORE_PASSPHRASE;
  const file = env.SIGNER_KEYSTORE_PASSPHRASE_FILE;
  if (inline && file) {
    throw new KeystoreError(
      'set SIGNER_KEYSTORE_PASSPHRASE or SIGNER_KEYSTORE_PASSPHRASE_FILE, not both',
    );
  }
  if (inline) return inline;
  if (!file) {
    throw new KeystoreError(
      'SIGNER_KEYSTORE_PASSPHRASE or SIGNER_KEYSTORE_PASSPHRASE_FILE is required by the local backend',
    );
  }
  let passphrase: string;
  try {
    passphrase = readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch {
    throw new KeystoreError(`SIGNER_KEYSTORE_PASSPHRASE_FILE ${file} is unreadable`);
  }
  if (passphrase === '')
    throw new KeystoreError(`SIGNER_KEYSTORE_PASSPHRASE_FILE ${file} is empty`);
  return passphrase;
}

/**
 * Encrypted key files in a directory, decrypted into process memory (ADR-0050).
 * Weaker than `aws-kms` and `privy`, which keep the key off this host:
 * anyone who can read this process's memory has the keys. `keyRef` is the
 * key's name.
 */
export function createLocalBackend(
  dir: string,
  passphrase: string,
  log: (message: string) => void = (message) => console.error(message),
): KeyBackend {
  log(
    `NOTICE: the local backend decrypts keys from ${dir} into this process's memory. ` +
      'Anyone who can read the host or the process can read them; prefer aws-kms or privy where you can.',
  );
  try {
    if ((statSync(dir).mode & 0o077) !== 0) {
      log(`WARNING: the keystore directory ${dir} is accessible to other users; chmod 700 it.`);
    }
  } catch {
    // A missing directory surfaces as "the keystore has no key" for each address.
  }

  /** name -> decrypted key. Filled on first use, which the startup check makes happen before listening. */
  const keys = new Map<string, { curve: Curve; key: Uint8Array; address: string }>();

  function load(curve: Curve, keyRef: string) {
    let held = keys.get(keyRef);
    if (!held) {
      const file = readKeyFile(dir, keyRef);
      held = { curve: file.curve, key: decryptKey(file, passphrase), address: file.address };
      keys.set(keyRef, held);
    }
    if (held.curve !== curve) {
      throw new KeystoreError(`key "${keyRef}" is a ${held.curve} key, not ${curve}`);
    }
    return held;
  }

  return {
    // Run inside a promise, so a throw is a rejection, as a caller of an async backend expects.
    address: (curve, keyRef) => Promise.resolve().then(() => load(curve, keyRef).address),
    sign: (curve, keyRef, payload) =>
      Promise.resolve().then(() => signWith(curve, load(curve, keyRef).key, payload)),
  };
}
