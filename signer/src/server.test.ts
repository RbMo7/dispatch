import { generateKeyPairSync, randomBytes, verify as nodeVerify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import bs58 from 'bs58';
import {
  getAddress,
  keccak256,
  recoverAddress,
  serializeTransaction,
  toHex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyfileBackend } from './backends/keyfile.js';
import type { KeyBackend } from './backends/key-backend.js';
import { lookupKey, parseSignerConfig } from './config.js';
import { createSignerServer, type AuditRecord, type Keyring } from './server.js';

const TOKEN = 'test-token';

const { publicKey: solanaPublicKey, privateKey: solanaPrivateKey } = generateKeyPairSync('ed25519');
const solanaSeed = Buffer.from(solanaPrivateKey.export({ format: 'jwk' }).d ?? '', 'base64url');
const solanaAddress = bs58.encode(
  Buffer.from(solanaPublicKey.export({ format: 'jwk' }).x ?? '', 'base64url'),
);

const evmKey = `0x${randomBytes(32).toString('hex')}` as const;
const evmAddress = privateKeyToAccount(evmKey).address;

const keyfilePath = path.join(mkdtempSync(path.join(tmpdir(), 'signer-server-')), 'keys.json');
writeFileSync(
  keyfilePath,
  JSON.stringify({
    secp256k1: { evm: evmKey.slice(2) },
    ed25519: { solana: solanaSeed.toString('hex') },
  }),
);

/** Built the way startup builds it: from a parsed config, with one backend behind every entry. */
function keyringFor(config: Record<string, unknown>, backend: KeyBackend): Keyring {
  return new Map(
    [...parseSignerConfig(config).values()].map((entry) => [
      lookupKey(entry.curve, entry.address),
      { entry, backend },
    ]),
  );
}

const keyfile = createKeyfileBackend(keyfilePath, () => {});
const keyring = keyringFor(
  {
    // Configured checksummed, as an operator copies it from a wallet.
    [evmAddress]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'evm' },
    [solanaAddress]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'solana' },
  },
  keyfile,
);

const eip1559: TransactionSerializableEIP1559 = {
  type: 'eip1559',
  chainId: 84532,
  nonce: 7,
  to: '0x000000000000000000000000000000000000dEaD',
  value: 1_000n,
  gas: 21_000n,
  maxFeePerGas: 2_000_000_000n,
  maxPriorityFeePerGas: 1_000_000n,
};
const unsignedEip1559 = serializeTransaction(eip1559);

async function listening(server: ReturnType<typeof createSignerServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: ReturnType<typeof createSignerServer>): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

describe('createSignerServer', () => {
  let baseUrl: string;
  let server: ReturnType<typeof createSignerServer>;
  let audited: AuditRecord[];

  beforeEach(async () => {
    audited = [];
    server = createSignerServer({
      keyring,
      authToken: TOKEN,
      audit: (line) => audited.push(JSON.parse(line) as AuditRecord),
    });
    baseUrl = await listening(server);
  });

  afterEach(() => close(server));

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

  async function signature(response: Response): Promise<Buffer> {
    return Buffer.from(((await response.json()) as { signature: string }).signature, 'base64');
  }

  it('refuses to start without a bearer token', () => {
    expect(() => createSignerServer({ keyring, authToken: '' })).toThrow(
      /SIGNER_AUTH_TOKEN is required/,
    );
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'Bearer not-the-token'],
    ['a wrong token of the same length', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['the token without its Bearer scheme', TOKEN],
  ])('answers 401 to a request with %s, without reading it', async (_, authorization) => {
    const response = await postSign(
      {
        chain: 'solana',
        curve: 'ed25519',
        address: solanaAddress,
        unsignedTransaction: 'ZGF0YQ==',
      },
      authorization,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'missing or wrong bearer token' });
    expect(audited).toEqual([
      {
        time: expect.any(String) as string,
        decision: 'rejected',
        status: 401,
        reason: 'missing or wrong bearer token',
      },
    ]);
  });

  it('signs a Solana message as given, audited with its signature as the transaction id', async () => {
    const message = Buffer.from('unsigned message bytes');

    const response = await postSign({
      chain: 'solana',
      curve: 'ed25519',
      address: solanaAddress,
      unsignedTransaction: message.toString('base64'),
    });

    expect(response.status).toBe(200);
    const signed = await signature(response);
    expect(nodeVerify(null, message, solanaPublicKey, signed)).toBe(true);
    expect(audited).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
        address: solanaAddress,
        chain: 'solana',
        transactionId: bs58.encode(signed),
        decision: 'signed',
        status: 200,
      },
    ]);
  });

  it('hashes an EVM unsigned transaction itself: the signature recovers over its keccak256 to the address', async () => {
    const response = await postSign({
      chain: 'base',
      curve: 'secp256k1',
      address: evmAddress,
      unsignedTransaction: Buffer.from(unsignedEip1559.slice(2), 'hex').toString('base64'),
    });

    expect(response.status).toBe(200);
    const signed = await signature(response);
    expect(signed).toHaveLength(65);
    const recovered = await recoverAddress({
      hash: keccak256(unsignedEip1559),
      signature: {
        r: toHex(signed.subarray(0, 32)),
        s: toHex(signed.subarray(32, 64)),
        yParity: signed[64] ?? 0,
      },
    });
    expect(recovered).toBe(evmAddress);
  });

  it('audits an EVM signing with the hash of the transaction the engine will send', async () => {
    await postSign({
      chain: 'base',
      curve: 'secp256k1',
      address: evmAddress,
      unsignedTransaction: Buffer.from(unsignedEip1559.slice(2), 'hex').toString('base64'),
    });

    // viem's own account signer, with deterministic (RFC 6979) signatures, so the same bytes.
    const sent = await privateKeyToAccount(evmKey).signTransaction(eip1559);
    expect(audited).toEqual([
      {
        time: expect.any(String) as string,
        address: evmAddress,
        chain: 'base',
        transactionId: keccak256(sent),
        decision: 'signed',
        status: 200,
      },
    ]);
  });

  it.each([
    ['lowercase', evmAddress.toLowerCase()],
    ['checksummed', getAddress(evmAddress)],
    ['uppercase hex', `0x${evmAddress.slice(2).toUpperCase()}`],
  ])('finds an EVM address written in %s', async (_, address) => {
    const response = await postSign({
      chain: 'base',
      curve: 'secp256k1',
      address,
      unsignedTransaction: Buffer.from(unsignedEip1559.slice(2), 'hex').toString('base64'),
    });

    expect(response.status).toBe(200);
  });

  it('rejects a request without unsignedTransaction, as a Signer client on the old contract sends', async () => {
    const response = await postSign({ chain: 'solana', curve: 'ed25519', address: solanaAddress });

    expect(response.status).toBe(400);
    expect(audited).toEqual([
      {
        time: expect.any(String) as string,
        address: solanaAddress,
        chain: 'solana',
        decision: 'rejected',
        status: 400,
        reason: 'unsignedTransaction is required',
      },
    ]);
  });

  it('rejects an unsupported curve', async () => {
    const response = await postSign({
      chain: 'evm',
      curve: 'not-a-curve',
      address: solanaAddress,
      unsignedTransaction: 'ZGF0YQ==',
    });

    expect(response.status).toBe(400);
  });

  it.each([['not json'], ['null'], ['42']])('rejects the body %s', async (body) => {
    const response = await fetch(`${baseUrl}/sign`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}` },
      body,
    });

    expect(response.status).toBe(400);
    expect(audited).toMatchObject([{ decision: 'rejected', status: 400 }]);
  });

  it('rejects EVM bytes that are no transaction, without signing them', async () => {
    const response = await postSign({
      chain: 'base',
      curve: 'secp256k1',
      address: evmAddress,
      unsignedTransaction: Buffer.concat([Buffer.from([0x02]), randomBytes(80)]).toString('base64'),
    });

    expect(response.status).toBe(400);
    expect(audited).toMatchObject([{ decision: 'rejected', status: 400 }]);
  });

  it('rejects an unknown address', async () => {
    const response = await postSign({
      chain: 'solana',
      curve: 'ed25519',
      address: 'someone-else',
      unsignedTransaction: 'ZGF0YQ==',
    });

    expect(response.status).toBe(404);
    expect(audited).toEqual([
      {
        time: expect.any(String) as string,
        address: 'someone-else',
        chain: 'solana',
        decision: 'rejected',
        status: 404,
        reason: 'no key for address someone-else on curve ed25519',
      },
    ]);
  });

  it('rejects a Solana address in another case: base58 is case-sensitive', async () => {
    const response = await postSign({
      chain: 'solana',
      curve: 'ed25519',
      address: solanaAddress.toLowerCase(),
      unsignedTransaction: 'ZGF0YQ==',
    });

    expect(response.status).toBe(404);
  });

  it('rejects a known address asked for on a curve other than its own', async () => {
    const response = await postSign({
      chain: 'solana',
      curve: 'ed25519',
      address: evmAddress.toLowerCase(),
      unsignedTransaction: 'ZGF0YQ==',
    });

    expect(response.status).toBe(404);
  });

  it('rejects a non-/sign route', async () => {
    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(404);
    expect(audited).toMatchObject([{ decision: 'rejected', status: 404 }]);
  });
});

describe('a backend failure', () => {
  it('answers 500 instead of hanging, audited as failed', async () => {
    const failing: KeyBackend = {
      address: () => Promise.resolve(solanaAddress),
      sign: () => Promise.reject(new Error('key store unavailable')),
    };
    const audited: AuditRecord[] = [];
    const server = createSignerServer({
      keyring: keyringFor(
        { [solanaAddress]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'solana' } },
        failing,
      ),
      authToken: TOKEN,
      audit: (line) => audited.push(JSON.parse(line) as AuditRecord),
    });
    const baseUrl = await listening(server);

    try {
      const response = await fetch(`${baseUrl}/sign`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address: solanaAddress,
          unsignedTransaction: 'ZGF0YQ==',
        }),
      });

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'signing failed: key store unavailable' });
      expect(audited).toEqual([
        {
          time: expect.any(String) as string,
          address: solanaAddress,
          chain: 'solana',
          decision: 'failed',
          status: 500,
          reason: 'signing failed: key store unavailable',
        },
      ]);
    } finally {
      await close(server);
    }
  });
});
