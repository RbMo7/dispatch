import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { PublicKey } from '@solana/web3.js';
import { privateKeyToAccount } from 'viem/accounts';
import { toHex } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { KeyBackend } from './backends/key-backend.js';
import { lookupKey, parseSignerConfig } from './config.js';
import { createSignerServer, type AuditRecord, type Keyring } from './server.js';

const TOKEN = 'test-token';
const SEED_MARKER = 'seed-marker-never-in-a-response';

const evm = privateKeyToAccount(toHex(randomBytes(32)));
const plainEvm = privateKeyToAccount(toHex(randomBytes(32)));
const solana = new PublicKey(randomBytes(32)).toBase58();
const multisig = new PublicKey(randomBytes(32)).toBase58();
const safe = privateKeyToAccount(toHex(randomBytes(32))).address;

/** A backend that must never be asked to sign: reading a policy is not a signature. */
let signCalls = 0;
const backend: KeyBackend = {
  address: () => Promise.reject(new Error('unused')),
  sign: () => {
    signCalls += 1;
    return Promise.reject(new Error('the policy route must never sign'));
  },
};

const keyring: Keyring = new Map(
  [
    ...parseSignerConfig({
      [evm.address]: {
        curve: 'secp256k1',
        backend: 'keyfile',
        keyRef: SEED_MARKER,
        policy: {
          chainIds: [84532, 8453],
          allowedSafe: safe.toLowerCase(),
          allowedDestinations: [plainEvm.address],
          maxNativePerTransaction: '5',
        },
      },
      [plainEvm.address]: { curve: 'secp256k1', backend: 'keyfile', keyRef: SEED_MARKER },
      [solana]: {
        curve: 'ed25519',
        backend: 'keyfile',
        keyRef: SEED_MARKER,
        policy: { allowedMultisig: multisig },
      },
    }).values(),
  ].map((entry) => [lookupKey(entry.curve, entry.address), { entry, backend }]),
);

describe('GET /keys/{address}/policy (ADR-0055)', () => {
  let baseUrl: string;
  let server: ReturnType<typeof createSignerServer>;
  let audited: AuditRecord[];

  beforeEach(async () => {
    audited = [];
    signCalls = 0;
    server = createSignerServer({
      keyring,
      authToken: TOKEN,
      audit: (line) => audited.push(JSON.parse(line) as AuditRecord),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

  function read(address: string, authorization: string | null = `Bearer ${TOKEN}`) {
    return fetch(`${baseUrl}/keys/${encodeURIComponent(address)}/policy`, {
      headers: authorization === null ? {} : { authorization },
    });
  }

  it('returns an EVM key’s Safe pin and chains, and no other part of its policy', async () => {
    const response = await read(evm.address);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      address: evm.address,
      curve: 'secp256k1',
      chainIds: [8453, 84532],
      allowedSafe: safe.toLowerCase(),
    });
    expect(text).not.toContain(SEED_MARKER);
    expect(text).not.toContain('allowedDestinations');
    expect(text).not.toContain('maxNative');
  });

  it('returns a Solana key’s multisig pin', async () => {
    const response = await read(solana);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      address: solana,
      curve: 'ed25519',
      allowedMultisig: multisig,
    });
  });

  it('returns no pin fields for a key without pins', async () => {
    const response = await read(plainEvm.address);

    expect(await response.json()).toEqual({ address: plainEvm.address, curve: 'secp256k1' });
  });

  it('finds an EVM address whatever its case', async () => {
    const response = await read(evm.address.toLowerCase());

    expect(response.status).toBe(200);
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'Bearer not-the-token'],
  ])('answers 401 to a request with %s', async (_, authorization) => {
    const response = await read(evm.address, authorization);

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain(safe);
    expect(audited[0]).toMatchObject({ decision: 'rejected', status: 401 });
  });

  it('answers 404 "no key for address" for an unknown address, the wording the engine matches on', async () => {
    const response = await read('0x000000000000000000000000000000000000dEaD');

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toMatch(/^no key for address /);
  });

  it('still answers 404 "not found" for an unknown route, so an engine can tell an old Signer apart', async () => {
    const response = await fetch(`${baseUrl}/keys/${evm.address}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not found' });
  });

  it('audits a read without making a signature', async () => {
    await read(evm.address);

    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      kind: 'policy-read',
      address: evm.address,
      decision: 'read',
    });
    expect(signCalls).toBe(0);
  });
});
