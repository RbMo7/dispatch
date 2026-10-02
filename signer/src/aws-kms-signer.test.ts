import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { keccak256, recoverAddress, serializeTransaction, toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBackends } from './backends/index.js';
import { buildSigner } from './startup.js';

/** AWS KMS, stood in for by keys generated locally; the SDK's real command classes are kept. */
const kms = vi.hoisted(() => ({
  keys: new Map<string, { spki: Uint8Array; key: Uint8Array }>(),
  keySpecs: new Map<string, string>(),
  clients: [] as unknown[],
  commands: [] as unknown[],
}));

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kms')>();
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');

  class KMSClient {
    constructor(config: unknown) {
      kms.clients.push(config);
    }
    send(command: unknown) {
      kms.commands.push(command);
      if (command instanceof actual.GetPublicKeyCommand) {
        const keyId = command.input.KeyId ?? '';
        const held = kms.keys.get(keyId);
        if (!held) return Promise.reject(new Error(`KMS: no key ${keyId}`));
        return Promise.resolve({
          KeySpec: kms.keySpecs.get(keyId) ?? 'ECC_SECG_P256K1',
          KeyUsage: 'SIGN_VERIFY',
          PublicKey: held.spki,
        });
      }
      if (command instanceof actual.SignCommand) {
        const held = kms.keys.get(command.input.KeyId ?? '');
        if (!held || !command.input.Message) return Promise.reject(new Error('KMS: bad Sign'));
        return Promise.resolve({
          Signature: secp256k1.sign(command.input.Message, held.key, {
            prehash: false,
            format: 'der',
          }),
        });
      }
      return Promise.reject(new Error('KMS: unexpected command'));
    }
  }
  return { ...actual, KMSClient };
});

function writeJson(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'signer-kms-')), 'config.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

/** Puts a new secp256k1 key in the fake KMS under `keyId`, returning its address. */
function kmsKey(keyId: string): `0x${string}` {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const key = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
  kms.keys.set(keyId, {
    spki: new Uint8Array(publicKey.export({ type: 'spki', format: 'der' })),
    key,
  });
  return privateKeyToAddress(toHex(key));
}

const env = (SIGNER_CONFIG: string) => ({ SIGNER_AUTH_TOKEN: 'test-token', SIGNER_CONFIG });

afterEach(() => {
  kms.keys.clear();
  kms.keySpecs.clear();
  kms.clients.length = 0;
  kms.commands.length = 0;
});

describe('the Signer on AWS KMS keys', () => {
  it('signs an EVM transaction through KMS for its address', async () => {
    const address = kmsKey('kms-key');
    const config = writeJson({
      [address]: { curve: 'secp256k1', backend: 'aws-kms', keyRef: 'kms-key' },
    });
    const server = await buildSigner(env(config), () => {});
    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const unsigned = serializeTransaction({
        type: 'eip1559',
        chainId: 84532,
        nonce: 0,
        to: privateKeyToAddress(toHex(randomBytes(32))),
        value: 1n,
        gas: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      });
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
        body: JSON.stringify({
          chain: 'base',
          curve: 'secp256k1',
          address,
          unsignedTransaction: Buffer.from(unsigned.slice(2), 'hex').toString('base64'),
        }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { signature: string };
      const signature = Buffer.from(body.signature, 'base64');
      expect(
        await recoverAddress({
          hash: keccak256(unsigned),
          signature: {
            r: toHex(signature.subarray(0, 32)),
            s: toHex(signature.subarray(32, 64)),
            yParity: signature[64] ?? 0,
          },
        }),
      ).toBe(address);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses to start when a key has a different address, naming both', async () => {
    const configured = privateKeyToAddress(toHex(randomBytes(32)));
    const actual = kmsKey('kms-key');
    const config = writeJson({
      [configured]: { curve: 'secp256k1', backend: 'aws-kms', keyRef: 'kms-key' },
    });

    await expect(buildSigner(env(config))).rejects.toThrow(
      `${configured}: expected ${configured}, derived ${actual}`,
    );
  });

  it("refuses to start when a key isn't a secp256k1 key", async () => {
    const address = kmsKey('p256-key');
    kms.keySpecs.set('p256-key', 'ECC_NIST_P256');
    const config = writeJson({
      [address]: { curve: 'secp256k1', backend: 'aws-kms', keyRef: 'p256-key' },
    });

    await expect(buildSigner(env(config))).rejects.toThrow(
      `${address}: KMS key p256-key is ECC_NIST_P256 for SIGN_VERIFY; it must be ECC_SECG_P256K1 for SIGN_VERIFY`,
    );
  });

  it('refuses to start on an ed25519 address, without asking KMS', async () => {
    const config = writeJson({
      '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe': {
        curve: 'ed25519',
        backend: 'aws-kms',
        keyRef: 'kms-key',
      },
    });

    await expect(buildSigner(env(config))).rejects.toThrow(
      '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe: aws-kms supports secp256k1 only; see #51',
    );
    expect(kms.commands).toEqual([]);
  });
});

describe('createBackends for aws-kms', () => {
  it('builds its KMS client with no configuration of its own', () => {
    createBackends(['aws-kms'], {});

    expect(kms.clients).toEqual([{}]);
  });

  it('asks nothing of KMS when no address uses it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(createBackends(['keyfile'], { SIGNER_KEYFILE: writeJson({}) }).has('aws-kms')).toBe(
      false,
    );
    expect(kms.clients).toEqual([]);
    vi.restoreAllMocks();
  });
});
