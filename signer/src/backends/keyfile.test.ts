import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  verify as nodeVerify,
} from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import bs58 from 'bs58';
import { keccak256 } from 'viem';
import { describe, expect, it, vi } from 'vitest';

import { createKeyfileBackend } from './keyfile.js';

const DEV_KEYFILE = fileURLToPath(new URL('../../keys.dev.json', import.meta.url));

function writeKeyfile(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'signer-keyfile-')), 'keys.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

const quiet = () => {};

/** Derived with Node's own crypto, not the backend's @noble/curves. */
function solanaAddressOf(seed: Buffer): string {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
  const jwk = createPublicKey(
    createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' }),
  ).export({ format: 'jwk' });
  return bs58.encode(Buffer.from(jwk.x ?? '', 'base64url'));
}

describe('createKeyfileBackend', () => {
  it('warns that it is for development only', () => {
    const warn = vi.fn();
    createKeyfileBackend(writeKeyfile({}), warn);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatch(/development only/);
  });

  it("derives the dev keys' addresses, as viem and @solana/web3.js derive them", async () => {
    const backend = createKeyfileBackend(DEV_KEYFILE, quiet);

    // Computed once with viem's privateKeyToAccount and web3.js's Keypair.fromSeed.
    expect(await backend.address('secp256k1', 'dev-sender')).toBe(
      '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
    );
    expect(await backend.address('ed25519', 'dev-sender')).toBe(
      '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe',
    );
  });

  it('derives the EVM address of any key: keccak256 of its public key, last 20 bytes', async () => {
    const key = randomBytes(32);
    const backend = createKeyfileBackend(
      writeKeyfile({ secp256k1: { sender: key.toString('hex') } }),
      quiet,
    );

    const expected = keccak256(secp256k1.getPublicKey(key, false).subarray(1)).slice(-40);
    expect((await backend.address('secp256k1', 'sender')).toLowerCase()).toBe(`0x${expected}`);
  });

  it('derives the Solana address of any key: its base58 ed25519 public key', async () => {
    const seed = randomBytes(32);
    const backend = createKeyfileBackend(
      writeKeyfile({ ed25519: { sender: seed.toString('hex') } }),
      quiet,
    );

    expect(await backend.address('ed25519', 'sender')).toBe(solanaAddressOf(seed));
  });

  it('signs a secp256k1 digest as given, r || s || recovery, recovering to the key', async () => {
    const key = randomBytes(32);
    const backend = createKeyfileBackend(
      writeKeyfile({ secp256k1: { sender: key.toString('hex') } }),
      quiet,
    );
    const digest = randomBytes(32);

    const signature = await backend.sign('secp256k1', 'sender', digest);

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

  it('signs an ed25519 message that verifies against the public key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
    const backend = createKeyfileBackend(
      writeKeyfile({ ed25519: { sender: seed.toString('hex') } }),
      quiet,
    );
    const message = Buffer.from('unsigned message bytes');

    const signature = await backend.sign('ed25519', 'sender', message);

    expect(nodeVerify(null, message, publicKey, signature)).toBe(true);
  });

  it('rejects, rather than throws, for a missing or malformed key', async () => {
    const backend = createKeyfileBackend(writeKeyfile({ ed25519: { short: 'ab' } }), quiet);

    await expect(backend.address('ed25519', 'absent')).rejects.toThrow(
      'the keyfile has no ed25519 key "absent"',
    );
    await expect(backend.sign('ed25519', 'short', Buffer.from('m'))).rejects.toThrow(/32-byte/);
  });
});
