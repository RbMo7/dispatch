import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { recoverAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyfileBackend } from './backends/keyfile.js';
import { createLocalBackend } from './backends/local.js';
import { encryptKey, writeKeyFile } from './backends/keystore.js';
import type { KeyBackend } from './backends/key-backend.js';
import { lookupKey, parseSignerConfig } from './config.js';
import { createSignerServer, type AuditRecord, type Keyring } from './server.js';
import vectors from './safe-vectors.json' with { type: 'json' };

const TOKEN = 'test-token';
const UNSAFE_CONTENTS = 'secret-calldata-marker';

const key = randomBytes(32);
const account = privateKeyToAccount(toHex(key));
const other = privateKeyToAccount(toHex(randomBytes(32)));

const dir = mkdtempSync(path.join(tmpdir(), 'signer-safe-'));
const keyfilePath = path.join(dir, 'keys.json');
writeFileSync(
  keyfilePath,
  JSON.stringify({ secp256k1: { evm: key.toString('hex') }, ed25519: {} }),
);

const keystore = mkdtempSync(path.join(tmpdir(), 'signer-safe-keystore-'));
writeKeyFile(keystore, 'evm', encryptKey('secp256k1', key, 'passphrase', 2 ** 10));

const backends: [string, () => KeyBackend][] = [
  ['keyfile', () => createKeyfileBackend(keyfilePath, () => {})],
  ['local', () => createLocalBackend(keystore, 'passphrase', () => {})],
];

function keyringFor(config: Record<string, unknown>, backend: KeyBackend): Keyring {
  return new Map(
    [...parseSignerConfig(config).values()].map((entry) => [
      lookupKey(entry.curve, entry.address),
      { entry, backend },
    ]),
  );
}

const [vector] = vectors;
const safeTransaction = vector?.tx as Record<string, unknown>;

function request(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'safeTransaction',
    chain: 'base',
    curve: 'secp256k1',
    address: account.address,
    safeTransaction,
    ...overrides,
  };
}

describe.each(backends)('the Signer signing a Safe transaction on the %s backend', (_, backend) => {
  let baseUrl: string;
  let server: ReturnType<typeof createSignerServer>;
  let audited: AuditRecord[];
  let lines: string[];

  async function startWith(entry: Record<string, unknown>) {
    audited = [];
    lines = [];
    server = createSignerServer({
      keyring: keyringFor(
        { [account.address]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'evm', ...entry } },
        backend(),
      ),
      authToken: TOKEN,
      audit: (line) => {
        lines.push(line);
        audited.push(JSON.parse(line) as AuditRecord);
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  beforeEach(() => startWith({}));
  afterEach(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );

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

  it.each(vectors)(
    'signs the Safe digest for $name: 65 bytes, v 27 or 28, recovering to the key',
    async ({ tx, safeTxHash }) => {
      const response = await postSign(request({ safeTransaction: tx }));

      expect(response.status).toBe(200);
      const signed = Buffer.from(
        ((await response.json()) as { signature: string }).signature,
        'base64',
      );
      expect(signed).toHaveLength(65);
      expect([27, 28]).toContain(signed[64]);
      expect(
        await recoverAddress({ hash: safeTxHash as `0x${string}`, signature: toHex(signed) }),
      ).toBe(account.address);
    },
  );

  it('audits the kind, the Safe, the nonce and the Safe transaction hash, without its contents', async () => {
    await postSign(
      request({ safeTransaction: { ...safeTransaction, data: toHex(UNSAFE_CONTENTS) } }),
    );

    expect(audited).toEqual([
      {
        time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/) as string,
        address: account.address,
        chain: 'base',
        kind: 'safeTransaction',
        safe: '0x84ac281b68de095f6227050f56c74d93d294e609',
        safeNonce: '0',
        transactionId: expect.stringMatching(/^0x[0-9a-f]{64}$/) as string,
        decision: 'signed',
        status: 200,
      },
    ]);
    expect(lines.join('')).not.toContain(toHex(UNSAFE_CONTENTS).slice(2));
    expect(lines.join('')).not.toContain(key.toString('hex'));
  });

  it('leaves an ordinary request’s audit line without the Safe fields', async () => {
    await postSign({ chain: 'base', curve: 'secp256k1', address: account.address });

    expect(audited[0]).not.toHaveProperty('kind');
    expect(audited[0]).not.toHaveProperty('safe');
  });

  it.each([
    ['an unknown kind', request({ kind: 'typedData' }), /unsupported kind/],
    ['a null kind', request({ kind: null }), /unsupported kind/],
    ['no safeTransaction', request({ safeTransaction: undefined }), /must be an object/],
    [
      'a malformed field',
      request({ safeTransaction: { ...safeTransaction, value: 1 } }),
      /value must be/,
    ],
    ['an ed25519 curve', request({ curve: 'ed25519' }), /secp256k1/],
    ['no address', request({ address: undefined }), /address is required/],
  ])('answers 400 to %s, audited as rejected', async (_name, body, message) => {
    const response = await postSign(body);

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(message);
    expect(audited[0]).toMatchObject({ decision: 'rejected', status: 400 });
  });

  it('answers 404 for an address it holds no key for', async () => {
    const response = await postSign(request({ address: other.address }));

    expect(response.status).toBe(404);
  });

  it.each([
    ['no token', null],
    ['a wrong token', 'Bearer not-the-token'],
  ])('answers 401 to %s, without signing', async (_name, authorization) => {
    const response = await postSign(request(), authorization);

    expect(response.status).toBe(401);
    expect(audited).toEqual([expect.objectContaining({ decision: 'rejected', status: 401 })]);
    expect(audited[0]).not.toHaveProperty('transactionId');
  });

  it('refuses a key whose policy has no allowedSafe with 403 { error, reason }, audited, without signing', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startWith({ policy: { chainIds: [84532] } });

    const response = await postSign(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'policy refused',
      reason: 'the policy has no allowedSafe, so it does not sign Safe transactions',
    });
    expect(audited).toEqual([
      expect.objectContaining({
        kind: 'safeTransaction',
        safeNonce: '0',
        decision: 'refused',
        status: 403,
      }),
    ]);
    expect(audited[0]).not.toHaveProperty('transactionId');
  });

  it('signs a pinned Safe’s MultiSend delegatecall and audits it as signed', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startWith({ policy: { chainIds: [84532], allowedSafe: vectors[1]?.tx.safe } });

    const response = await postSign(request({ safeTransaction: vectors[1]?.tx }));

    expect(response.status).toBe(200);
    expect(audited).toEqual([
      expect.objectContaining({ kind: 'safeTransaction', decision: 'signed', status: 200 }),
    ]);
  });

  it('refuses a CALL for a pinned Safe with 403 { error, reason }, audited with the reason, without signing', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startWith({ policy: { chainIds: [84532], allowedSafe: vectors[0]?.tx.safe } });

    const response = await postSign(request());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: 'policy refused',
      reason: 'the Safe transaction is a call; only a delegatecall to MultiSendCallOnly is allowed',
    });
    expect(audited[0]).toMatchObject({
      decision: 'refused',
      status: 403,
      reason: 'the Safe transaction is a call; only a delegatecall to MultiSendCallOnly is allowed',
    });
    expect(audited[0]).not.toHaveProperty('transactionId');
  });

  it('refuses even with an empty policy', async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await startWith({ policy: {} });

    expect((await postSign(request())).status).toBe(403);
  });
});
