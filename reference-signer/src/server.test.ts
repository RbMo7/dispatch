import { verify as nodeVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Keyring } from './keys.js';
import { createSignerServer } from './server.js';

const TOKEN = 'test-token';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const seedHex = Buffer.from(privateKey.export({ format: 'jwk' }).d ?? '', 'base64url').toString(
  'hex',
);

const evmKey = randomBytes(32);
const evmAddress = evmAddressOf(secp256k1.getPublicKey(evmKey, false));

function evmAddressOf(uncompressedPublicKey: Uint8Array): string {
  return `0x${Buffer.from(keccak_256(uncompressedPublicKey.subarray(1)).subarray(12)).toString('hex')}`;
}

const keyring: Keyring = {
  ed25519: { 'dev-sender': seedHex },
  secp256k1: { [evmAddress]: evmKey.toString('hex') },
};

describe('createSignerServer', () => {
  let baseUrl: string;
  let server: ReturnType<typeof createSignerServer>;

  beforeEach(async () => {
    server = createSignerServer(keyring, TOKEN);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });

  function postSign(body: unknown, authorization: string | null = `Bearer ${TOKEN}`) {
    return fetch(`${baseUrl}/sign`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization === null ? {} : { authorization }),
      },
      body: JSON.stringify(body),
    });
  }

  it('refuses to start without a bearer token', () => {
    expect(() => createSignerServer(keyring, '')).toThrow(/SIGNER_AUTH_TOKEN is required/);
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'Bearer not-the-token'],
    ['a wrong token of the same length', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['the token without its Bearer scheme', TOKEN],
  ])('answers 401 to a request with %s, without signing', async (_, authorization) => {
    const response = await postSign(
      {
        chain: 'solana',
        curve: 'ed25519',
        address: 'dev-sender',
        unsignedTransaction: 'ZGF0YQ==',
      },
      authorization,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing or wrong bearer token' });
  });

  it('signs a Solana message as given and returns a valid ed25519 signature', async () => {
    const unsignedTransaction = Buffer.from('unsigned message bytes').toString('base64');

    const response = await postSign({
      chain: 'solana',
      curve: 'ed25519',
      address: 'dev-sender',
      unsignedTransaction,
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { signature: string };
    const signature = Buffer.from(body.signature, 'base64');
    expect(
      nodeVerify(null, Buffer.from(unsignedTransaction, 'base64'), publicKey, signature),
    ).toBe(true);
  });

  it('hashes an EVM unsigned transaction itself: the signature recovers over its keccak256 to the address', async () => {
    // Stands in for `0x02 || rlp(...)`: the Signer hashes whatever it is given.
    const payload = Buffer.concat([Buffer.from([0x02]), randomBytes(80)]);

    const response = await postSign({
      chain: 'base',
      curve: 'secp256k1',
      address: evmAddress,
      unsignedTransaction: payload.toString('base64'),
    });

    expect(response.status).toBe(200);
    const signature = Buffer.from(((await response.json()) as { signature: string }).signature, 'base64');
    expect(signature).toHaveLength(65);
    const recovered = new secp256k1.Signature(
      BigInt(`0x${signature.subarray(0, 32).toString('hex')}`),
      BigInt(`0x${signature.subarray(32, 64).toString('hex')}`),
      signature[64],
    ).recoverPublicKey(keccak_256(payload));
    expect(evmAddressOf(recovered.toBytes(false))).toBe(evmAddress);
  });

  it('rejects a request without unsignedTransaction, as a Signer client on the old contract sends', async () => {
    const response = await postSign({ chain: 'solana', curve: 'ed25519', address: 'dev-sender' });

    expect(response.status).toBe(400);
  });

  it('rejects an unsupported curve', async () => {
    const response = await postSign({
      chain: 'evm',
      curve: 'not-a-curve',
      address: 'dev-sender',
      unsignedTransaction: 'ZGF0YQ==',
    });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown address', async () => {
    const response = await postSign({
      chain: 'solana',
      curve: 'ed25519',
      address: 'someone-else',
      unsignedTransaction: 'ZGF0YQ==',
    });

    expect(response.status).toBe(404);
  });

  it('rejects a non-/sign route', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(404);
  });

  it('returns a structured error instead of hanging when the stored key is malformed', async () => {
    const badKeyring: Keyring = { ed25519: { 'bad-sender': 'not-hex' }, secp256k1: {} };
    const badServer = createSignerServer(badKeyring, TOKEN);
    await new Promise<void>((resolve) => badServer.listen(0, resolve));
    const { port } = badServer.address() as AddressInfo;

    try {
      const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address: 'bad-sender',
          unsignedTransaction: 'ZGF0YQ==',
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
