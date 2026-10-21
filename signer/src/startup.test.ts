import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { encryptKey, writeKeyFile } from './backends/keystore.js';
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

describe('buildSigner with the local backend', () => {
  const PASSPHRASE = 'startup test passphrase';

  /** A keystore holding one ed25519 key "ops", plus its address. */
  function keystore(passphrase = PASSPHRASE) {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'signer-local-')), 'keystore');
    const file = encryptKey('ed25519', randomBytes(32), passphrase, 2 ** 10);
    writeKeyFile(dir, 'ops', file);
    return { dir, address: file.address };
  }

  const localEnv = (dir: string, overrides: Record<string, string | undefined> = {}) =>
    env({ SIGNER_KEYSTORE_DIR: dir, SIGNER_KEYSTORE_PASSPHRASE: PASSPHRASE, ...overrides });

  async function sign(server: Awaited<ReturnType<typeof buildSigner>>, address: string) {
    await new Promise<void>((resolve) => server.listen(0, resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address,
          unsignedTransaction: Buffer.from('not a transaction').toString('base64'),
        }),
      });
      return response.status;
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('signs for a local address next to a keyfile one in the same config', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, address } = keystore();
    const config = writeJson({
      [EVM]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'dev-sender' },
      [address]: { curve: 'ed25519', backend: 'local', keyRef: 'ops' },
    });
    const audit = vi.fn();

    const server = await buildSigner(localEnv(dir, { SIGNER_CONFIG: config }), audit);

    expect(await sign(server, address)).toBe(200);
    expect(JSON.parse(audit.mock.calls[0]?.[0] as string)).toMatchObject({
      address,
      decision: 'signed',
    });
    vi.restoreAllMocks();
  });

  it('applies an address policy to a local key unchanged', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, address } = keystore();
    const config = writeJson({
      [address]: {
        curve: 'ed25519',
        backend: 'local',
        keyRef: 'ops',
        policy: { maxNativePerTransaction: '1' },
      },
    });

    const server = await buildSigner(localEnv(dir, { SIGNER_CONFIG: config }));

    // With a policy set, bytes the Signer can't read as a transaction are refused.
    expect(await sign(server, address)).toBe(403);
    vi.restoreAllMocks();
  });

  it('logs that local keeps keys in process memory', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, address } = keystore();
    const config = writeJson({ [address]: { curve: 'ed25519', backend: 'local', keyRef: 'ops' } });

    await buildSigner(localEnv(dir, { SIGNER_CONFIG: config }));

    expect(log.mock.calls.map(([line]) => String(line)).join('\n')).toMatch(/process's memory/);
    vi.restoreAllMocks();
  });

  it('refuses to start on a wrong passphrase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, address } = keystore();
    const config = writeJson({ [address]: { curve: 'ed25519', backend: 'local', keyRef: 'ops' } });

    await expect(
      buildSigner(localEnv(dir, { SIGNER_CONFIG: config, SIGNER_KEYSTORE_PASSPHRASE: 'wrong' })),
    ).rejects.toThrow(`${address}: the key file did not decrypt`);
    vi.restoreAllMocks();
  });

  it('refuses to start when the configured address differs from the key, naming both', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, address } = keystore();
    const config = writeJson({ [SOLANA]: { curve: 'ed25519', backend: 'local', keyRef: 'ops' } });

    await expect(buildSigner(localEnv(dir, { SIGNER_CONFIG: config }))).rejects.toThrow(
      `${SOLANA}: expected ${SOLANA}, derived ${address}`,
    );
    vi.restoreAllMocks();
  });

  it.each([
    [
      'there is no keystore directory',
      { SIGNER_KEYSTORE_DIR: undefined },
      /SIGNER_KEYSTORE_DIR is required/,
    ],
    [
      'there is no passphrase',
      { SIGNER_KEYSTORE_PASSPHRASE: undefined },
      /SIGNER_KEYSTORE_PASSPHRASE or SIGNER_KEYSTORE_PASSPHRASE_FILE is required/,
    ],
  ])('refuses to start when %s', async (_, overrides, error) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dir, address } = keystore();
    const config = writeJson({ [address]: { curve: 'ed25519', backend: 'local', keyRef: 'ops' } });

    await expect(
      buildSigner(localEnv(dir, { SIGNER_CONFIG: config, ...overrides })),
    ).rejects.toThrow(error);
    vi.restoreAllMocks();
  });

  it('asks for no keystore settings when no address uses local', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(buildSigner(env({}))).resolves.toBeDefined();
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
