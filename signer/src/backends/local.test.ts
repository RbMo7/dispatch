import { createPrivateKey, createPublicKey, randomBytes, verify as nodeVerify } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import bs58 from 'bs58';
import { getAddress, keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { createLocalBackend, keystoreDir, keystorePassphrase } from './local.js';
import {
  decryptKey,
  encryptKey,
  KeystoreError,
  listKeys,
  readKeyFile,
  writeKeyFile,
  type KeyFile,
} from './keystore.js';
import type { Curve } from './key-backend.js';

/** A cheap scrypt cost; the format is the same at any `n`. */
const FAST = 2 ** 10;
const PASSPHRASE = 'correct horse battery staple';

const tempDir = () => mkdtempSync(path.join(tmpdir(), 'signer-keystore-'));
const quiet = () => {};

/** Derived with Node's own crypto, not the backend's @noble/curves. */
function solanaAddressOf(seed: Buffer): string {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const jwk = createPublicKey(
    createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  ).export({ format: 'jwk' });
  return bs58.encode(Buffer.from(jwk.x ?? '', 'base64url'));
}

function evmAddressOf(key: Buffer): string {
  return `0x${keccak256(secp256k1.getPublicKey(key, false).subarray(1)).slice(-40)}`;
}

function addressOfCurve(curve: Curve, key: Buffer): string {
  return curve === 'secp256k1' ? evmAddressOf(key) : solanaAddressOf(key);
}

/** Writes one key to a fresh keystore and returns where it is. */
function keystoreWith(curve: Curve, name: string, key: Buffer, passphrase = PASSPHRASE) {
  const dir = tempDir();
  writeKeyFile(dir, name, encryptKey(curve, key, passphrase, FAST));
  return dir;
}

describe.each<Curve>(['secp256k1', 'ed25519'])('the key file (%s)', (curve) => {
  const key =
    curve === 'secp256k1' ? Buffer.from(secp256k1.utils.randomSecretKey()) : randomBytes(32);

  it('round-trips a key through its passphrase', () => {
    const file = encryptKey(curve, key, PASSPHRASE, FAST);

    expect(Buffer.from(decryptKey(file, PASSPHRASE))).toEqual(key);
  });

  it('records the version, curve and the address derived independently of the backend', () => {
    const file = encryptKey(curve, key, PASSPHRASE, FAST);

    expect(file).toMatchObject({ version: 1, curve, kdf: { name: 'scrypt' } });
    expect(file.address.toLowerCase()).toBe(addressOfCurve(curve, key).toLowerCase());
    expect(file.cipher.name).toBe('aes-256-gcm');
  });

  it('keeps the private key out of the file', () => {
    const file = JSON.stringify(encryptKey(curve, key, PASSPHRASE, FAST));

    expect(file).not.toContain(key.toString('hex'));
  });

  it('does not encrypt the same key the same way twice', () => {
    const a = encryptKey(curve, key, PASSPHRASE, FAST);
    const b = encryptKey(curve, key, PASSPHRASE, FAST);

    expect(a.cipher.ciphertext).not.toBe(b.cipher.ciphertext);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
  });

  it('refuses a wrong passphrase without saying anything about the key', () => {
    const file = encryptKey(curve, key, PASSPHRASE, FAST);

    expect(() => decryptKey(file, 'not the passphrase')).toThrow(KeystoreError);
    expect(() => decryptKey(file, 'not the passphrase')).toThrow(
      /passphrase is wrong, or the file was altered/,
    );
  });

  it.each<[string, (file: KeyFile) => KeyFile]>([
    [
      'a flipped ciphertext byte',
      (f) => ({ ...f, cipher: { ...f.cipher, ciphertext: flipFirstNibble(f.cipher.ciphertext) } }),
    ],
    [
      'a flipped tag byte',
      (f) => ({ ...f, cipher: { ...f.cipher, tag: flipFirstNibble(f.cipher.tag) } }),
    ],
    [
      'a flipped iv byte',
      (f) => ({ ...f, cipher: { ...f.cipher, iv: flipFirstNibble(f.cipher.iv) } }),
    ],
    [
      'a flipped salt byte',
      (f) => ({ ...f, kdf: { ...f.kdf, salt: flipFirstNibble(f.kdf.salt) } }),
    ],
    [
      'an edited address',
      (f) => ({
        ...f,
        address:
          f.curve === 'ed25519' ? solanaAddressOf(randomBytes(32)) : evmAddressOf(randomBytes(32)),
      }),
    ],
    ['an edited curve', (f) => ({ ...f, curve: f.curve === 'ed25519' ? 'secp256k1' : 'ed25519' })],
  ])('refuses a file with %s, leaking nothing', (_, tamper) => {
    const file = tamper(encryptKey(curve, key, PASSPHRASE, FAST));

    const attempt = () => decryptKey(file, PASSPHRASE);

    expect(attempt).toThrow(KeystoreError);
    expect(attempt).toThrow(/did not decrypt/);
    try {
      attempt();
    } catch (cause) {
      expect(String(cause)).not.toContain(key.toString('hex'));
      expect((cause as Error).message).not.toContain(PASSPHRASE);
    }
  });
});

function flipFirstNibble(hex: string): string {
  return `${hex[0] === '0' ? '1' : '0'}${hex.slice(1)}`;
}

describe('a key file on disk', () => {
  const key = randomBytes(32);

  it('is owner-only (0600) in an owner-only (0700) directory the CLI had to create', () => {
    const dir = path.join(tempDir(), 'nested', 'keystore');

    writeKeyFile(dir, 'sender', encryptKey('ed25519', key, PASSPHRASE, FAST));

    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path.join(dir, 'sender.json')).mode & 0o777).toBe(0o600);
  });

  it('is never overwritten', () => {
    const dir = keystoreWith('ed25519', 'sender', key);
    const before = readFileSync(path.join(dir, 'sender.json'), 'utf8');

    expect(() =>
      writeKeyFile(dir, 'sender', encryptKey('ed25519', randomBytes(32), PASSPHRASE, FAST)),
    ).toThrow('a key named "sender" already exists');
    expect(readFileSync(path.join(dir, 'sender.json'), 'utf8')).toBe(before);
  });

  it.each(['../escape', 'a/b', '.hidden', '', 'a b', 'x'.repeat(65)])(
    'refuses the key name %j, which could name a file elsewhere',
    (name) => {
      expect(() =>
        writeKeyFile(tempDir(), name, encryptKey('ed25519', key, PASSPHRASE, FAST)),
      ).toThrow(/key name is 1 to 64/);
    },
  );

  it.each<[string, unknown]>([
    ['a newer version', { version: 2 }],
    ['an unknown curve', { version: 1, curve: 'p256' }],
    ['not an object', []],
    [
      'a scrypt cost outside the accepted range',
      {
        ...encryptKey('ed25519', key, PASSPHRASE, FAST),
        kdf: { name: 'scrypt', n: 2 ** 30, r: 8, p: 1, salt: '00'.repeat(16) },
      },
    ],
  ])('refuses a file with %s, plainly', (_, contents) => {
    const dir = tempDir();
    writeFileSync(path.join(dir, 'bad.json'), JSON.stringify(contents));

    expect(() => readKeyFile(dir, 'bad')).toThrow(KeystoreError);
    expect(() => readKeyFile(dir, 'bad')).toThrow(/^key "bad": /);
  });

  it('lists names, curves and addresses without a passphrase', () => {
    const dir = tempDir();
    const secp = Buffer.from(secp256k1.utils.randomSecretKey());
    writeKeyFile(dir, 'b-evm', encryptKey('secp256k1', secp, PASSPHRASE, FAST));
    writeKeyFile(dir, 'a-sol', encryptKey('ed25519', key, PASSPHRASE, FAST));
    writeFileSync(path.join(dir, 'notes.txt'), 'not a key');

    expect(listKeys(dir)).toEqual([
      { name: 'a-sol', curve: 'ed25519', address: solanaAddressOf(key) },
      { name: 'b-evm', curve: 'secp256k1', address: getAddress(evmAddressOf(secp)) },
    ]);
    expect(listKeys(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('createLocalBackend', () => {
  it('says that it keeps keys in process memory', () => {
    const log = vi.fn();
    createLocalBackend(tempDir(), PASSPHRASE, log);

    expect(log.mock.calls[0]?.[0]).toMatch(/process's memory/);
  });

  it('warns about a keystore directory other users can read', () => {
    const closed = vi.fn();
    createLocalBackend(tempDir(), PASSPHRASE, closed); // mkdtemp makes it 0700
    expect(closed).toHaveBeenCalledOnce();

    const open = tempDir();
    chmodSync(open, 0o755);
    const log = vi.fn();
    createLocalBackend(open, PASSPHRASE, log);

    expect(log).toHaveBeenCalledTimes(2);
    expect(log.mock.calls[1]?.[0]).toMatch(/accessible to other users/);
  });

  it('derives the secp256k1 address, and signs a digest that recovers to the key', async () => {
    const key = Buffer.from(secp256k1.utils.randomSecretKey());
    const backend = createLocalBackend(keystoreWith('secp256k1', 'evm', key), PASSPHRASE, quiet);
    const digest = randomBytes(32);

    expect((await backend.address('secp256k1', 'evm')).toLowerCase()).toBe(evmAddressOf(key));
    const signature = await backend.sign('secp256k1', 'evm', digest);

    expect(signature).toHaveLength(65);
    const recovered = new secp256k1.Signature(
      BigInt(`0x${Buffer.from(signature.subarray(0, 32)).toString('hex')}`),
      BigInt(`0x${Buffer.from(signature.subarray(32, 64)).toString('hex')}`),
      signature[64],
    ).recoverPublicKey(digest);
    expect(Buffer.from(recovered.toBytes(true))).toEqual(
      Buffer.from(secp256k1.getPublicKey(key, true)),
    );
  });

  it('derives the ed25519 address, and signs a message that verifies', async () => {
    const seed = randomBytes(32);
    const backend = createLocalBackend(keystoreWith('ed25519', 'sol', seed), PASSPHRASE, quiet);
    const message = Buffer.from('unsigned message bytes');

    const address = await backend.address('ed25519', 'sol');
    const signature = await backend.sign('ed25519', 'sol', message);

    expect(address).toBe(solanaAddressOf(seed));
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        Buffer.from(bs58.decode(address)),
      ]),
      format: 'der',
      type: 'spki',
    });
    expect(nodeVerify(null, message, publicKey, signature)).toBe(true);
  });

  it('rejects, rather than throws, for a wrong passphrase, and says what to check', async () => {
    const dir = keystoreWith('ed25519', 'sol', randomBytes(32));
    const backend = createLocalBackend(dir, 'wrong passphrase', quiet);

    await expect(backend.address('ed25519', 'sol')).rejects.toThrow(/passphrase is wrong/);
    await expect(backend.sign('ed25519', 'sol', Buffer.from('m'))).rejects.toThrow(
      /passphrase is wrong/,
    );
  });

  it('rejects a tampered file', async () => {
    const dir = keystoreWith('ed25519', 'sol', randomBytes(32));
    const file = path.join(dir, 'sol.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyFile;
    parsed.cipher.ciphertext = flipFirstNibble(parsed.cipher.ciphertext);
    writeFileSync(file, JSON.stringify(parsed));

    await expect(
      createLocalBackend(dir, PASSPHRASE, quiet).address('ed25519', 'sol'),
    ).rejects.toThrow(/did not decrypt/);
  });

  it('rejects a missing key, and a key asked for under the wrong curve', async () => {
    const backend = createLocalBackend(
      keystoreWith('ed25519', 'sol', randomBytes(32)),
      PASSPHRASE,
      quiet,
    );

    await expect(backend.address('ed25519', 'absent')).rejects.toThrow(
      'the keystore has no key "absent"',
    );
    await expect(backend.address('secp256k1', 'sol')).rejects.toThrow(
      'key "sol" is a ed25519 key, not secp256k1',
    );
  });

  it('decrypts a key once, then signs from memory', async () => {
    const dir = keystoreWith('ed25519', 'sol', randomBytes(32));
    const backend = createLocalBackend(dir, PASSPHRASE, quiet);
    await backend.address('ed25519', 'sol');

    writeFileSync(path.join(dir, 'sol.json'), 'gone');

    await expect(backend.sign('ed25519', 'sol', Buffer.from('m'))).resolves.toHaveLength(64);
  });
});

describe('the keystore settings', () => {
  it('needs SIGNER_KEYSTORE_DIR', () => {
    expect(() => keystoreDir({})).toThrow('SIGNER_KEYSTORE_DIR is required by the local backend');
    expect(() => keystoreDir({ SIGNER_KEYSTORE_DIR: '' })).toThrow(/is required/);
    expect(keystoreDir({ SIGNER_KEYSTORE_DIR: '/k' })).toBe('/k');
  });

  it('needs a passphrase, from the environment or a mounted file, not both', () => {
    const file = path.join(tempDir(), 'passphrase');
    writeFileSync(file, 'from a file\n');
    const empty = path.join(tempDir(), 'empty');
    writeFileSync(empty, '\n');

    expect(() => keystorePassphrase({})).toThrow(
      /SIGNER_KEYSTORE_PASSPHRASE or SIGNER_KEYSTORE_PASSPHRASE_FILE is required/,
    );
    expect(keystorePassphrase({ SIGNER_KEYSTORE_PASSPHRASE: 'inline' })).toBe('inline');
    expect(keystorePassphrase({ SIGNER_KEYSTORE_PASSPHRASE_FILE: file })).toBe('from a file');
    expect(() =>
      keystorePassphrase({
        SIGNER_KEYSTORE_PASSPHRASE: 'a',
        SIGNER_KEYSTORE_PASSPHRASE_FILE: file,
      }),
    ).toThrow(/not both/);
    expect(() => keystorePassphrase({ SIGNER_KEYSTORE_PASSPHRASE_FILE: '/nonexistent' })).toThrow(
      /unreadable/,
    );
    expect(() => keystorePassphrase({ SIGNER_KEYSTORE_PASSPHRASE_FILE: empty })).toThrow(
      /is empty/,
    );
  });
});
