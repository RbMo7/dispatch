import { verify as nodeVerify, generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Keyring } from './keys.js';
import { createSignerServer } from './server.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const seedHex = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url').toString(
  'hex',
);

const keyring: Keyring = {
  ed25519: { 'dev-sender': seedHex },
  secp256k1: {},
};

describe('createSignerServer', () => {
  let baseUrl: string;
  let server: ReturnType<typeof createSignerServer>;

  beforeEach(async () => {
    server = createSignerServer(keyring);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  it('signs a request for a known address and returns a valid signature', async () => {
    const unsignedTxBytes = Buffer.from('unsigned tx bytes').toString('base64');

    const response = await fetch(`${baseUrl}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chain: 'solana',
        curve: 'ed25519',
        address: 'dev-sender',
        unsignedTxBytes,
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { signature: string };
    const signature = Buffer.from(body.signature, 'base64');
    expect(nodeVerify(null, Buffer.from(unsignedTxBytes, 'base64'), publicKey, signature)).toBe(
      true,
    );
  });

  it('rejects an unsupported curve', async () => {
    const response = await fetch(`${baseUrl}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chain: 'evm',
        curve: 'not-a-curve',
        address: 'dev-sender',
        unsignedTxBytes: 'ZGF0YQ==',
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown address', async () => {
    const response = await fetch(`${baseUrl}/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chain: 'solana',
        curve: 'ed25519',
        address: 'someone-else',
        unsignedTxBytes: 'ZGF0YQ==',
      }),
    });

    expect(response.status).toBe(404);
  });

  it('rejects a non-/sign route', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(404);
  });

  it('returns a structured error instead of hanging when the stored key is malformed', async () => {
    const badKeyring: Keyring = { ed25519: { 'bad-sender': 'not-hex' }, secp256k1: {} };
    const badServer = createSignerServer(badKeyring);
    await new Promise<void>((resolve) => badServer.listen(0, resolve));
    const { port } = badServer.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address: 'bad-sender',
          unsignedTxBytes: 'ZGF0YQ==',
        }),
      });

      expect(response.status).toBe(500);
      const body = (await response.json()) as { error: string };
      expect(typeof body.error).toBe('string');
    } finally {
      await new Promise<void>((resolve, reject) =>
        badServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
