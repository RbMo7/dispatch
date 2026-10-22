import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { readKeyFile, type KeyFile } from './backends/keystore.js';
import { createLocalBackend } from './backends/local.js';
import { runKeys } from './keys.js';

const signerDir = fileURLToPath(new URL('..', import.meta.url));
const PASSPHRASE = 'a passphrase that must never be printed';

type Run = { code: number; stdout: string; stderr: string; dir: string };

/** Runs the CLI in-process, capturing everything it writes. */
async function run(
  args: string[],
  { stdin = '', env = {}, dir = mkdtempSync(path.join(tmpdir(), 'signer-cli-')) } = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await runKeys(args, {
    env: { SIGNER_KEYSTORE_DIR: dir, SIGNER_KEYSTORE_PASSPHRASE: PASSPHRASE, ...env },
    readStdin: () => Promise.resolve(stdin),
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { code, stdout, stderr, dir };
}

/** Nothing the CLI wrote may contain these. */
function expectNoSecrets(result: Run, secrets: string[]) {
  const output = result.stdout + result.stderr;
  for (const secret of [PASSPHRASE, ...secrets]) expect(output).not.toContain(secret);
}

describe('signer keys new', () => {
  it.each([
    ['secp256k1', /^0x[0-9a-fA-F]{40}\n$/],
    ['ed25519', /^[1-9A-HJ-NP-Za-km-z]{32,44}\n$/],
  ])('makes a %s key and prints its address only', async (curve, shape) => {
    const result = await run(['new', '--curve', curve, '--name', 'sender']);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toMatch(shape);
    expectNoSecrets(result, []);
  });

  it('writes a key file that the backend decrypts to the address it printed', async () => {
    const result = await run(['new', '--curve', 'ed25519', '--name', 'sender']);

    const backend = createLocalBackend(result.dir, PASSPHRASE, () => {});
    expect(await backend.address('ed25519', 'sender')).toBe(result.stdout.trim());
    expect(readdirSync(result.dir)).toEqual(['sender.json']);
    expect(statSync(path.join(result.dir, 'sender.json')).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite a key', async () => {
    const first = await run(['new', '--curve', 'ed25519', '--name', 'sender']);
    const second = await run(['new', '--curve', 'secp256k1', '--name', 'sender'], {
      dir: first.dir,
    });

    expect(second).toMatchObject({ code: 1, stdout: '' });
    expect(second.stderr).toContain('a key named "sender" already exists');
    expect(readKeyFile(first.dir, 'sender').curve).toBe('ed25519');
  });
});

describe('signer keys import', () => {
  it.each(['0x', ''])(
    'reads a secp256k1 key from stdin (prefix %j) and prints only its address',
    async (prefix) => {
      const key = Buffer.from(secp256k1.utils.randomSecretKey()).toString('hex');

      const result = await run(['import', '--curve', 'secp256k1', '--name', 'base'], {
        stdin: `${prefix}${key}\n`,
      });

      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toBe(`${privateKeyToAddress(`0x${key}`)}\n`);
      expectNoSecrets(result, [key]);
      expect(readFileSync(path.join(result.dir, 'base.json'), 'utf8')).not.toContain(key);
    },
  );

  it('reads an ed25519 seed from stdin', async () => {
    const seed = randomBytes(32).toString('hex');

    const result = await run(['import', '--curve', 'ed25519', '--name', 'sol'], { stdin: seed });

    expect(result.code).toBe(0);
    const backend = createLocalBackend(result.dir, PASSPHRASE, () => {});
    expect(await backend.address('ed25519', 'sol')).toBe(result.stdout.trim());
  });

  it.each([
    ['too short', 'abcd'],
    ['not hex', 'zz'.repeat(32)],
    ['a secp256k1 zero key', '00'.repeat(32)],
    ['a key with extra text', `${'ab'.repeat(32)} and more`],
    ['empty', ''],
  ])('refuses %s without echoing it', async (_, stdin) => {
    const result = await run(['import', '--curve', 'secp256k1', '--name', 'bad'], { stdin });

    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toMatch(/^error: /);
    if (stdin !== '') expect(result.stderr).not.toContain(stdin.trim());
    expect(readdirSync(result.dir)).toEqual([]);
  });

  it.each(['--key', '--private-key', '--passphrase', '--key=abc'])(
    'refuses %s as an argument, and does not repeat what followed it',
    async (flag) => {
      const secret = 'ab'.repeat(32);

      const result = await run(['import', '--curve', 'ed25519', '--name', 'x', flag, secret]);

      expect(result).toMatchObject({ code: 2, stdout: '' });
      expect(result.stderr).toContain('read from stdin, not an argument');
      expectNoSecrets(result, [secret]);
    },
  );

  it('refuses a positional private key without echoing it', async () => {
    const secret = 'cd'.repeat(32);

    const result = await run(['import', '--curve', 'ed25519', '--name', 'x', secret]);

    expect(result.code).toBe(2);
    expectNoSecrets(result, [secret]);
  });
});

describe('signer keys list and export-public', () => {
  it('lists every key, and exports one address, with no passphrase', async () => {
    const a = await run(['new', '--curve', 'ed25519', '--name', 'ops-sender']);
    const b = await run(['new', '--curve', 'secp256k1', '--name', 'base-sender'], { dir: a.dir });
    const noPassphrase = { dir: a.dir, env: { SIGNER_KEYSTORE_PASSPHRASE: '' } };

    const list = await run(['list'], noPassphrase);
    const exported = await run(['export-public', '--name', 'ops-sender'], noPassphrase);

    expect(list).toMatchObject({ code: 0, stderr: '' });
    expect(list.stdout).toBe(
      `base-sender\tsecp256k1\t${b.stdout.trim()}\nops-sender\ted25519\t${a.stdout.trim()}\n`,
    );
    expect(exported).toMatchObject({ code: 0, stdout: a.stdout, stderr: '' });
  });

  it('says so when a key does not exist', async () => {
    const result = await run(['export-public', '--name', 'nope']);

    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(result.stderr).toContain('the keystore has no key "nope"');
  });

  it('never prints key material from a key file, even a damaged one', async () => {
    const made = await run(['new', '--curve', 'ed25519', '--name', 'sender']);
    const file = path.join(made.dir, 'sender.json');
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as KeyFile;
    writeFileSync(file, JSON.stringify({ ...parsed, kdf: { ...parsed.kdf, n: 3 } }));

    const list = await run(['list'], { dir: made.dir });
    const exported = await run(['export-public', '--name', 'sender'], { dir: made.dir });

    for (const result of [list, exported]) {
      expect(result).toMatchObject({ code: 1, stdout: '' });
      expectNoSecrets(result, [parsed.cipher.ciphertext, parsed.cipher.tag]);
    }
  });
});

describe('signer keys, misused', () => {
  it.each([
    ['no command', [], 0],
    ['an unknown command', ['export-private', '--name', 'x'], 2],
    ['an unknown curve', ['new', '--curve', 'rsa', '--name', 'x'], 2],
    ['a missing curve', ['new', '--name', 'x'], 2],
    ['a missing name', ['new', '--curve', 'ed25519'], 2],
    ['a name that escapes the directory', ['new', '--curve', 'ed25519', '--name', '../x'], 1],
    ['an option the command does not take', ['list', '--name', 'x'], 2],
  ])('prints usage for %s, with no key', async (_, args, code) => {
    const result = await run(args);

    expect(result.code).toBe(code);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/usage|error/);
  });

  it('needs the keystore directory, and a passphrase to make a key', async () => {
    const noDir = await run(['list'], { env: { SIGNER_KEYSTORE_DIR: '' } });
    const noPassphrase = await run(['new', '--curve', 'ed25519', '--name', 'x'], {
      env: { SIGNER_KEYSTORE_PASSPHRASE: '' },
    });

    expect(noDir).toMatchObject({ code: 1, stdout: '' });
    expect(noDir.stderr).toContain('SIGNER_KEYSTORE_DIR is required');
    expect(noPassphrase).toMatchObject({ code: 1, stdout: '' });
    expect(noPassphrase.stderr).toContain('SIGNER_KEYSTORE_PASSPHRASE');
  });
});

describe('the signer keys process', () => {
  it('makes, lists and imports through real stdin, and never prints the key', () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'signer-cli-proc-')), 'keystore');
    const env = {
      ...process.env,
      SIGNER_KEYSTORE_DIR: dir,
      SIGNER_KEYSTORE_PASSPHRASE: PASSPHRASE,
    };
    const cli = (args: string[], input?: string) =>
      spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'keys', ...args], {
        cwd: signerDir,
        env,
        input,
        encoding: 'utf8',
        timeout: 30_000,
      });
    const key = Buffer.from(secp256k1.utils.randomSecretKey()).toString('hex');

    const made = cli(['new', '--curve', 'ed25519', '--name', 'ops']);
    const imported = cli(['import', '--curve', 'secp256k1', '--name', 'base'], key);
    const list = cli(['list']);

    expect([made.status, imported.status, list.status]).toEqual([0, 0, 0]);
    expect(imported.stdout).toBe(`${privateKeyToAddress(`0x${key}`)}\n`);
    expect(list.stdout.split('\n').filter(Boolean)).toHaveLength(2);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    for (const result of [made, imported, list]) {
      expect(result.stdout + result.stderr).not.toContain(key);
      expect(result.stdout + result.stderr).not.toContain(PASSPHRASE);
    }
  });

  it('exits non-zero for anything but the keys group', () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'sign'], {
      cwd: signerDir,
      encoding: 'utf8',
      timeout: 30_000,
    });

    expect(result.status).toBe(2);
  });
});
