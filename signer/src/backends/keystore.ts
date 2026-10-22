import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  type ScryptOptions,
} from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { secp256k1 } from '@noble/curves/secp256k1.js';

import { CURVES, type Curve } from './key-backend.js';
import { addressOf } from './raw-key.js';

/**
 * The `local` backend's key files (ADR-0050): one JSON file per key, its
 * 32-byte private key encrypted with AES-256-GCM under a key scrypt derives
 * from the operator's passphrase. Everything here throws `KeystoreError`,
 * whose messages never contain key material, so a caller may print them.
 */
export class KeystoreError extends Error {}

export const KEYSTORE_VERSION = 1;

/** 2^17, scrypt's usual interactive-login-and-up cost: ~128 MiB and a fraction of a second per key at startup. */
export const DEFAULT_SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Bounds on a file's own `n`, so a doctored file can't make startup cost nothing or everything. */
const MIN_SCRYPT_N = 2 ** 10;
const MAX_SCRYPT_N = 2 ** 20;

/** What a key file holds. Binary fields are hex. */
export type KeyFile = {
  version: typeof KEYSTORE_VERSION;
  curve: Curve;
  address: string;
  kdf: { name: 'scrypt'; n: number; r: number; p: number; salt: string };
  cipher: { name: 'aes-256-gcm'; iv: string; tag: string; ciphertext: string };
};

/** Key names become file names, so they can't reach outside the keystore directory. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function assertKeyName(name: string): void {
  if (!NAME.test(name)) {
    throw new KeystoreError(
      'a key name is 1 to 64 letters, digits, ".", "_" or "-", starting with a letter or digit',
    );
  }
}

/** Binds the ciphertext to what the file claims, so editing its curve or address fails authentication. */
function aad(curve: Curve, address: string): Buffer {
  return Buffer.from(`dispatch-signer-keystore:v${KEYSTORE_VERSION}:${curve}:${address}`);
}

function derive(passphrase: string, salt: Buffer, n: number): Buffer {
  const options: ScryptOptions = {
    N: n,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * n * SCRYPT_R + 2 ** 20,
  };
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, options);
}

/** Throws when `key` isn't a usable private key for `curve`, without saying what it was. */
export function assertValidKey(curve: Curve, key: Uint8Array): void {
  try {
    if (key.length !== KEY_BYTES) throw new Error('length');
    addressOf(curve, key);
  } catch {
    throw new KeystoreError(`not a valid ${curve} private key (expected 32 bytes)`);
  }
}

export function generateKey(curve: Curve): Uint8Array {
  return curve === 'secp256k1' ? secp256k1.utils.randomSecretKey() : randomBytes(KEY_BYTES);
}

export function encryptKey(
  curve: Curve,
  key: Uint8Array,
  passphrase: string,
  n: number = DEFAULT_SCRYPT_N,
): KeyFile {
  assertValidKey(curve, key);
  const address = addressOf(curve, key);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', derive(passphrase, salt, n), iv);
  cipher.setAAD(aad(curve, address));
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  return {
    version: KEYSTORE_VERSION,
    curve,
    address,
    kdf: { name: 'scrypt', n, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('hex') },
    cipher: {
      name: 'aes-256-gcm',
      iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkHex(value: unknown, bytes: number, what: string): void {
  if (typeof value !== 'string' || !/^[0-9a-f]*$/.test(value) || value.length !== bytes * 2) {
    throw new KeystoreError(`the key file's ${what} is malformed`);
  }
}

/** Checks a parsed key file's shape, so a hand-edited or foreign file fails with a plain message. */
export function parseKeyFile(raw: unknown): KeyFile {
  if (!isRecord(raw)) throw new KeystoreError('the key file is not a JSON object');
  if (raw.version !== KEYSTORE_VERSION) {
    throw new KeystoreError(
      `the key file is version ${JSON.stringify(raw.version)}; this Signer reads version ${KEYSTORE_VERSION}`,
    );
  }
  const { curve, address, kdf, cipher } = raw;
  if (!CURVES.includes(curve as Curve))
    throw new KeystoreError('the key file has an unknown curve');
  if (typeof address !== 'string' || address === '') {
    throw new KeystoreError("the key file's address is missing");
  }
  if (!isRecord(kdf) || kdf.name !== 'scrypt')
    throw new KeystoreError('the key file is not scrypt');
  const { n, r, p } = kdf;
  if (
    typeof n !== 'number' ||
    !Number.isInteger(n) ||
    n < MIN_SCRYPT_N ||
    n > MAX_SCRYPT_N ||
    (n & (n - 1)) !== 0 ||
    r !== SCRYPT_R ||
    p !== SCRYPT_P
  ) {
    throw new KeystoreError("the key file's scrypt parameters are not ones this Signer accepts");
  }
  if (!isRecord(cipher) || cipher.name !== 'aes-256-gcm') {
    throw new KeystoreError('the key file is not aes-256-gcm');
  }
  checkHex(kdf.salt, SALT_BYTES, 'salt');
  checkHex(cipher.iv, IV_BYTES, 'iv');
  checkHex(cipher.tag, TAG_BYTES, 'tag');
  checkHex(cipher.ciphertext, KEY_BYTES, 'ciphertext');
  return raw as KeyFile;
}

/**
 * The private key in `file`. A wrong passphrase and a tampered file fail
 * the same way, since GCM can't tell them apart, and the message says so.
 */
export function decryptKey(file: KeyFile, passphrase: string): Uint8Array {
  const { kdf, cipher } = file;
  let key: Buffer;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      derive(passphrase, Buffer.from(kdf.salt, 'hex'), kdf.n),
      Buffer.from(cipher.iv, 'hex'),
    );
    decipher.setAAD(aad(file.curve, file.address));
    decipher.setAuthTag(Buffer.from(cipher.tag, 'hex'));
    key = Buffer.concat([decipher.update(Buffer.from(cipher.ciphertext, 'hex')), decipher.final()]);
  } catch {
    throw new KeystoreError(
      'the key file did not decrypt: the passphrase is wrong, or the file was altered',
    );
  }
  // Authenticated, so a mismatch here means the file was written wrong, not tampered with.
  if (addressOf(file.curve, key) !== file.address) {
    throw new KeystoreError(
      'the key file decrypted to a key whose address is not the one it records',
    );
  }
  return key;
}

function fileOf(dir: string, name: string): string {
  assertKeyName(name);
  return path.join(dir, `${name}.json`);
}

/** Creates the directory owner-only if it is missing. An existing one is left as it is. */
export function ensureKeystoreDir(dir: string): void {
  if (existsSync(dir)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700); // mkdir's mode is masked by the umask
}

/** Writes a new key file, owner-only. Never overwrites: a key is only ever lost on purpose. */
export function writeKeyFile(dir: string, name: string, file: KeyFile): void {
  const target = fileOf(dir, name);
  ensureKeystoreDir(dir);
  try {
    writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new KeystoreError(`a key named "${name}" already exists`);
    }
    throw new KeystoreError(`could not write the key file for "${name}"`);
  }
}

export function readKeyFile(dir: string, name: string): KeyFile {
  let text: string;
  try {
    text = readFileSync(fileOf(dir, name), 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new KeystoreError(`the keystore has no key "${name}"`);
    }
    throw new KeystoreError(`could not read the key file for "${name}"`);
  }
  try {
    return parseKeyFile(JSON.parse(text));
  } catch (cause) {
    if (cause instanceof KeystoreError) throw new KeystoreError(`key "${name}": ${cause.message}`);
    throw new KeystoreError(`key "${name}": the key file is not valid JSON`);
  }
}

/** Every key's name, curve and recorded address. Reads no secret, so it needs no passphrase. */
export function listKeys(dir: string): { name: string; curve: Curve; address: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json') && NAME.test(entry.slice(0, -5)))
    .sort()
    .map((entry) => {
      const name = entry.slice(0, -5);
      const { curve, address } = readKeyFile(dir, name);
      return { name, curve, address };
    });
}
