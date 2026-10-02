import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { buildSigner } from './startup.js';

const signerDir = fileURLToPath(new URL('..', import.meta.url));
const DEV_CONFIG = path.join(signerDir, 'signer.config.dev.json');
const DEV_KEYFILE = path.join(signerDir, 'keys.dev.json');

const EVM = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';
const SOLANA = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';

function writeJson(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'signer-startup-')), 'file.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

const env = (overrides: Record<string, string | undefined>) => ({
  SIGNER_AUTH_TOKEN: 'test-token',
  SIGNER_CONFIG: DEV_CONFIG,
  SIGNER_KEYFILE: DEV_KEYFILE,
  ...overrides,
});

describe('buildSigner', () => {
  it('starts on the committed dev config: its addresses are the dev keys', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const audit = vi.fn();
    const server = await buildSigner(env({}), audit);
    await new Promise<void>((resolve) => server.listen(0, resolve));

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address: SOLANA,
          unsignedTransaction: Buffer.from('message').toString('base64'),
        }),
      });
      expect(response.status).toBe(200);
      expect(audit).toHaveBeenCalledOnce();
    } finally {
      await new Promise((resolve) => server.close(resolve));
      vi.restoreAllMocks();
    }
  });

  it('refuses to start when a key derives a different address, naming expected and derived', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const otherKey = randomBytes(32).toString('hex');
    const config = writeJson({
      [EVM]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'other' },
      [SOLANA]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'dev-sender' },
      '11111111111111111111111111111111': { curve: 'ed25519', backend: 'keyfile', keyRef: 'other' },
    });
    const keyfile = writeJson({
      secp256k1: { other: otherKey },
      ed25519: { 'dev-sender': randomBytes(32).toString('hex') },
    });

    const started = buildSigner(env({ SIGNER_CONFIG: config, SIGNER_KEYFILE: keyfile }));

    await expect(started).rejects.toThrow(
      new RegExp(
        `${EVM}: expected ${EVM}, derived 0x[0-9a-fA-F]{40}\\n` +
          `\\s+${SOLANA}: expected ${SOLANA}, derived \\w+\\n` +
          `\\s+11111111111111111111111111111111: the keyfile has no ed25519 key "other"`,
      ),
    );
    vi.restoreAllMocks();
  });

  it('matches an EVM address in any case', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const config = writeJson({
      [EVM.toLowerCase()]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'dev-sender' },
    });

    const server = await buildSigner(env({ SIGNER_CONFIG: config }));

    expect(server.listening).toBe(false);
    vi.restoreAllMocks();
  });

  it.each([
    ['SIGNER_CONFIG is unset', { SIGNER_CONFIG: undefined }, /SIGNER_CONFIG is required/],
    ['SIGNER_CONFIG is empty', { SIGNER_CONFIG: '' }, /SIGNER_CONFIG is required/],
    ['SIGNER_CONFIG is missing', { SIGNER_CONFIG: '/nonexistent.json' }, /unreadable/],
    [
      'the keyfile backend has no SIGNER_KEYFILE',
      { SIGNER_KEYFILE: undefined },
      /SIGNER_KEYFILE is required by the keyfile backend/,
    ],
    ['there is no auth token', { SIGNER_AUTH_TOKEN: undefined }, /SIGNER_AUTH_TOKEN is required/],
  ])('refuses to start when %s', async (_, overrides, error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(buildSigner(env(overrides))).rejects.toThrow(error);
    vi.restoreAllMocks();
  });
});

describe('the signer process', () => {
  it('exits non-zero, saying why, without SIGNER_CONFIG', () => {
    const withoutConfig = { ...process.env };
    delete withoutConfig.SIGNER_CONFIG;
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: signerDir,
      env: { ...withoutConfig, SIGNER_AUTH_TOKEN: 'test-token', PORT: '0' },
      encoding: 'utf8',
      timeout: 20_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/signer refused to start: SIGNER_CONFIG is required/);
    expect(result.stdout).toBe('');
  });
});
