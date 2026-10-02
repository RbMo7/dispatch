import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serializeTransaction, type Address } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { KeyBackend } from './backends/key-backend.js';
import type { AuditRecord } from './server.js';
import { buildSigner } from './startup.js';

const signs = vi.hoisted(() => ({ count: 0 }));

vi.mock('./backends/keyfile.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./backends/keyfile.js')>();
  return {
    createKeyfileBackend: (
      ...args: Parameters<typeof original.createKeyfileBackend>
    ): KeyBackend => {
      const backend = original.createKeyfileBackend(...args);
      return {
        address: (...addressArgs) => backend.address(...addressArgs),
        sign: (...signArgs) => {
          signs.count += 1;
          return backend.sign(...signArgs);
        },
      };
    },
  };
});

const DEV_KEYFILE = path.join(fileURLToPath(new URL('..', import.meta.url)), 'keys.dev.json');
const EVM = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';
const SOLANA = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';
const ALLOWED: Address = '0x000000000000000000000000000000000000dEaD';
const ELSEWHERE: Address = '0x00000000000000000000000000000000000b0b00';

function writeJson(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'signer-policy-')), 'config.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

const config = writeJson({
  [EVM]: {
    curve: 'secp256k1',
    backend: 'keyfile',
    keyRef: 'dev-sender',
    policy: { chainIds: [84532], allowedDestinations: [ALLOWED] },
  },
  [SOLANA]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'dev-sender' },
});

function payment(to: Address): string {
  const unsigned = serializeTransaction({
    type: 'eip1559',
    chainId: 84532,
    nonce: 0,
    to,
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000n,
  });
  return Buffer.from(unsigned.slice(2), 'hex').toString('base64');
}

describe('a Signer built with a policy', () => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => {
    await close?.();
    signs.count = 0;
    vi.restoreAllMocks();
  });

  async function started() {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const audited: AuditRecord[] = [];
    const server = await buildSigner(
      { SIGNER_AUTH_TOKEN: 'test-token', SIGNER_CONFIG: config, SIGNER_KEYFILE: DEV_KEYFILE },
      (line) => audited.push(JSON.parse(line) as AuditRecord),
    );
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => new Promise((resolve) => server.close(resolve));
    const { port } = server.address() as AddressInfo;
    const sign = (body: Record<string, unknown>) =>
      fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
        body: JSON.stringify(body),
      });
    return { audited, sign };
  }

  it('refuses a transaction outside it with 403 { error, reason }, audited, without signing', async () => {
    const { audited, sign } = await started();

    const response = await sign({
      chain: 'base',
      curve: 'secp256k1',
      address: EVM,
      unsignedTransaction: payment(ELSEWHERE),
    });

    const reason = `destination ${ELSEWHERE} is not in allowedDestinations`;
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'policy refused', reason });
    expect(audited).toEqual([
      expect.objectContaining({
        address: EVM,
        chain: 'base',
        decision: 'refused',
        status: 403,
        reason,
      }),
    ]);
    expect(audited[0]).not.toHaveProperty('transactionId');
    expect(signs.count).toBe(0);
  });

  it('refuses bytes it cannot decode for an address with a policy', async () => {
    const { sign } = await started();

    const response = await sign({
      chain: 'base',
      curve: 'secp256k1',
      address: EVM,
      unsignedTransaction: Buffer.from('not a transaction').toString('base64'),
    });

    expect(response.status).toBe(403);
    expect(((await response.json()) as { reason: string }).reason).toMatch(
      /^undecodable transaction: /,
    );
    expect(signs.count).toBe(0);
  });

  it('signs a transaction inside it', async () => {
    const { audited, sign } = await started();

    const response = await sign({
      chain: 'base',
      curve: 'secp256k1',
      address: EVM,
      unsignedTransaction: payment(ALLOWED),
    });

    expect(response.status).toBe(200);
    expect(audited).toEqual([expect.objectContaining({ decision: 'signed', status: 200 })]);
    expect(signs.count).toBe(1);
  });

  it('signs anything for an address without a policy, even bytes no decoder reads', async () => {
    const { sign } = await started();

    const response = await sign({
      chain: 'solana',
      curve: 'ed25519',
      address: SOLANA,
      unsignedTransaction: Buffer.from('not a message').toString('base64'),
    });

    expect(response.status).toBe(200);
    expect(signs.count).toBe(1);
  });
});
