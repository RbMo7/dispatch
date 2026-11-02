import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { configFrom, type Env } from '../config.js';
import { parseSendersConfig } from '../senders-config.js';
import { parseEnvText } from './env-file.js';
import { init, INIT_EXIT, type InitIo } from './init.js';
import { startServices, type Readiness, type Runner } from './init-services.js';
import { plainUi } from './init-ui.js';
import { findMissing, type Machine, type Probe } from './prerequisites.js';

const SIGNER_PACKAGE = fileURLToPath(new URL('../../signer', import.meta.url));
const SAFE = '0x1111111111111111111111111111111111111111';
const DEV_BASE_KEY = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';
const DEV_SOLANA_KEY = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';
const MAC: Machine = { platform: 'darwin', nodeVersion: 'v22.15.0' };

const realRun: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd ?? SIGNER_PACKAGE,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', (cause) => resolve({ code: 127, stdout, stderr: cause.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Every tool is installed, unless the test names one that is not. */
function probeWithout(...absent: string[]): Probe {
  return (command, args) => {
    const name = command === 'docker' && args[0] === 'compose' ? 'compose' : command;
    const missing = absent.includes(name) || (args[0] === 'info' && absent.includes('daemon'));
    return Promise.resolve({ ok: !missing, stdout: '' });
  };
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(env: Env = {}, probe: Probe = probeWithout()) {
  const root = mkdtempSync(path.join(tmpdir(), 'dispatch-init-'));
  roots.push(root);
  let output = '';
  const tokens: string[] = [];
  const doctorRuns: Env[] = [];
  const out = { write: (text: string) => (output += text) };
  let clock = Date.parse('2026-11-01T10:00:00Z');
  const io: InitIo = {
    root,
    signerPackage: SIGNER_PACKAGE,
    stdout: out,
    stderr: out,
    env: { ...process.env, ...env },
    terminal: false,
    machine: MAC,
    probe,
    run: realRun,
    runDoctor: (doctorEnv) => {
      doctorRuns.push(doctorEnv);
      out.write('doctor report\n');
      return Promise.resolve(0);
    },
    now: () => new Date((clock += 1000)),
    randomToken: () => {
      const token = randomBytes(32).toString('hex');
      tokens.push(token);
      return token;
    },
  };
  return {
    io,
    root,
    tokens,
    doctorRuns,
    output: () => output,
    file: (name: string) => readFileSync(path.join(root, name), 'utf8'),
    mode: (name: string) => statSync(path.join(root, name)).mode & 0o777,
    env: () => parseEnvText(readFileSync(path.join(root, '.env'), 'utf8')),
    signerConfig: () =>
      JSON.parse(
        readFileSync(path.join(root, 'signer/local/signer.config.json'), 'utf8'),
      ) as Record<
        string,
        { backend: string; keyRef: string; curve: string; policy: Record<string, unknown> }
      >,
    backups: () => readdirSync(root).filter((name) => name.startsWith('.env.backup-')),
    senders: () => JSON.parse(readFileSync(path.join(root, 'senders.json'), 'utf8')) as unknown,
  };
}

const EXISTING_ENV = [
  '# my own notes',
  'PORT=8420',
  'AUTH_TOKEN=dev-secret',
  'CUSTOM_SETTING=keep me',
  'SOLANA_KNOWN_TOKENS=USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6',
  '',
].join('\n');

describe('pnpm dispatch init --yes', () => {
  it('writes .env and the Signer config, keeps existing lines, backs up, and never prints a secret', async () => {
    const passphrase = `pass-${randomBytes(12).toString('hex')}`;
    const t = harness({ SIGNER_KEYSTORE_PASSPHRASE: passphrase });
    writeFileSync(path.join(t.root, '.env'), EXISTING_ENV, { mode: 0o644 });

    const code = await init(
      ['--yes', '--chains', 'solana', '--solana-signer', 'local', '--no-start'],
      t.io,
    );

    expect(code, t.output()).toBe(INIT_EXIT.ok);
    const env = t.env();
    for (const line of EXISTING_ENV.split('\n').filter(
      (l) => l !== '' && !l.startsWith('AUTH_TOKEN'),
    )) {
      expect(t.file('.env')).toContain(line);
    }
    expect(env.AUTH_TOKEN).not.toBe('dev-secret');
    expect(env.ENABLED_CHAINS).toBe('solana');
    expect(env.SOLANA_RPC_URL).toBe('https://api.devnet.solana.com');
    expect(env.SOLANA_SENDER_MODE).toBe('single');
    expect(env.SIGNER_CONFIG).toBe('/app/local/signer.config.json');

    const [address, entry] = Object.entries(t.signerConfig())[0]!;
    expect(env.SOLANA_SENDER_ADDRESS).toBe(address);
    expect(entry).toEqual({
      curve: 'ed25519',
      backend: 'local',
      keyRef: 'solana-sender',
      policy: {},
    });
    expect(existsSync(path.join(t.root, 'signer/local/keystore/solana-sender.json'))).toBe(true);

    expect(t.backups()).toHaveLength(1);
    expect(t.file(t.backups()[0]!)).toBe(EXISTING_ENV);
    expect(t.mode('.env')).toBe(0o600);
    expect(t.mode(t.backups()[0]!)).toBe(0o600);
    expect(t.mode('signer/local/signer.config.json')).toBe(0o600);

    expect(t.tokens).toHaveLength(3);
    expect([env.AUTH_TOKEN, env.OPERATOR_TOKEN, env.SIGNER_AUTH_TOKEN].sort()).toEqual(
      [...t.tokens].sort(),
    );
    for (const secret of [...t.tokens, passphrase]) expect(t.output()).not.toContain(secret);
    for (const file of [
      '.env',
      'signer/local/signer.config.json',
      'signer/local/keystore/solana-sender.json',
    ]) {
      expect(t.file(file)).not.toContain(passphrase);
    }

    expect(t.output()).toContain('docker compose up -d --build postgres signer');
    expect(t.output()).toContain('read -rs SIGNER_KEYSTORE_PASSPHRASE');
    expect(t.doctorRuns).toHaveLength(1);
    expect(t.doctorRuns[0]!.SOLANA_SENDER_ADDRESS).toBe(address);
    expect(t.output()).toMatch(
      new RegExp(`Solana ${address}\\n\\s+pays .*faucet: https://faucet.solana.com`),
    );
  });

  it('adds a second chain on a re-run, keeping the first chain, its key and every token', async () => {
    const passphrase = `pass-${randomBytes(12).toString('hex')}`;
    const t = harness({ SIGNER_KEYSTORE_PASSPHRASE: passphrase });
    await init(['--yes', '--chains', 'solana', '--solana-signer', 'local', '--no-start'], t.io);
    const first = t.env();
    const solanaKey = first.SOLANA_SENDER_ADDRESS!;

    t.io.env = { ...process.env, SIGNER_KEYSTORE_PASSPHRASE: undefined };
    const code = await init(
      [
        '--yes',
        '--chains',
        'solana,base',
        '--base-signer',
        'keyfile',
        '--base-sender',
        'safe',
        '--base-safe',
        SAFE,
        '--no-start',
      ],
      t.io,
    );

    expect(code, t.output()).toBe(INIT_EXIT.ok);
    const second = t.env();
    expect(second.ENABLED_CHAINS).toBe('solana,base');
    expect(second.SOLANA_SENDER_ADDRESS).toBe(solanaKey);
    for (const token of ['AUTH_TOKEN', 'OPERATOR_TOKEN', 'SIGNER_AUTH_TOKEN']) {
      expect(second[token]).toBe(first[token]);
    }
    expect(second.BASE_SENDER_MODE).toBe('safe');
    expect(second.BASE_SAFE_ADDRESS).toBe(SAFE);
    expect(second.BASE_SAFE_EXECUTOR_ADDRESS).toBe(DEV_BASE_KEY);
    expect(second.BASE_CHAIN_ID).toBe('84532');
    expect(t.signerConfig()).toEqual({
      [solanaKey]: { curve: 'ed25519', backend: 'local', keyRef: 'solana-sender', policy: {} },
      [DEV_BASE_KEY]: {
        curve: 'secp256k1',
        backend: 'keyfile',
        keyRef: 'dev-sender',
        policy: { chainIds: [84532], allowedSafe: SAFE },
      },
    });
    expect(readdirSync(path.join(t.root, 'signer/local/keystore'))).toEqual(['solana-sender.json']);
    expect(t.output()).toContain('Current setup');
    expect(t.output()).toContain(
      `Solana: devnet, plain Sender ${solanaKey}, local key solana-sender`,
    );
    expect(t.output()).toContain(`registers ${DEV_BASE_KEY} as a delegate`);
    expect(t.backups().length).toBeGreaterThanOrEqual(1);
  });

  it('adds a named Sender to a set-up chain without touching the first, then a third as the default', async () => {
    const passphrase = `pass-${randomBytes(12).toString('hex')}`;
    const t = harness({ SIGNER_KEYSTORE_PASSPHRASE: passphrase });
    await init(['--yes', '--chains', 'solana', '--solana-signer', 'local', '--no-start'], t.io);
    expect(existsSync(path.join(t.root, 'senders.json'))).toBe(false);
    const first = t.env();
    const firstKey = first.SOLANA_SENDER_ADDRESS!;
    const firstKeystore = t.file('signer/local/keystore/solana-sender.json');
    const firstEntry = t.signerConfig()[firstKey];

    const addRefunds = [
      '--yes',
      '--solana-sender-name',
      'refunds',
      '--solana-signer',
      'local',
      '--no-start',
    ];
    const code = await init(addRefunds, t.io);

    expect(code, t.output()).toBe(INIT_EXIT.ok);
    const refundsKey = Object.keys(t.signerConfig()).find((key) => key !== firstKey)!;
    expect(t.senders()).toEqual({
      solana: {
        default: 'default',
        senders: { default: { address: firstKey }, refunds: { address: refundsKey } },
      },
    });
    expect(t.mode('senders.json')).toBe(0o600);
    expect(t.signerConfig()[firstKey]).toEqual(firstEntry);
    expect(t.signerConfig()[refundsKey]).toMatchObject({
      backend: 'local',
      keyRef: 'solana-refunds',
    });
    expect(t.file('signer/local/keystore/solana-sender.json')).toBe(firstKeystore);
    const second = t.env();
    expect(second.SOLANA_SENDER_ADDRESS ?? '').toBe('');
    expect(second.SOLANA_RPC_URL).toBe(first.SOLANA_RPC_URL);
    for (const token of ['AUTH_TOKEN', 'OPERATOR_TOKEN', 'SIGNER_AUTH_TOKEN']) {
      expect(second[token]).toBe(first[token]);
    }
    expect(t.output()).toMatch(new RegExp(`refunds on Solana ${refundsKey}\\n\\s+pays`));

    const before = t.senders();
    const keys = readdirSync(path.join(t.root, 'signer/local/keystore')).sort();
    expect(await init(addRefunds, t.io)).toBe(INIT_EXIT.ok);
    expect(t.senders()).toEqual(before);
    expect(readdirSync(path.join(t.root, 'signer/local/keystore')).sort()).toEqual(keys);

    const third = await init(
      [
        '--yes',
        '--solana-sender-name',
        'payroll',
        '--solana-signer',
        'keyfile',
        '--solana-default',
        'payroll',
        '--no-start',
      ],
      t.io,
    );

    expect(third, t.output()).toBe(INIT_EXIT.ok);
    expect(t.senders()).toEqual({
      solana: {
        default: 'payroll',
        senders: {
          default: { address: firstKey },
          refunds: { address: refundsKey },
          payroll: { address: DEV_SOLANA_KEY },
        },
      },
    });
    const backups = readdirSync(t.root).filter((name) => name.startsWith('senders.json.backup-'));
    expect(backups.map((name) => JSON.parse(t.file(name)) as unknown)).toContainEqual(before);
    expect(t.output()).toContain(
      `default on Solana (default): devnet, plain Sender ${firstKey}, local key solana-sender`,
    );
    expect(t.output()).toContain(`refunds on Solana: devnet, plain Sender ${refundsKey}`);
    expect(t.output()).toContain('pnpm dev:worker');

    const config = configFrom(t.env());
    const engineReads = parseSendersConfig({
      source: { kind: 'file', path: 'senders.json', text: t.file('senders.json') },
      enabledChains: ['solana'],
      variables: { solana: config.solana.multisig, base: config.base.safe },
    });
    expect(engineReads.warnings).toEqual([]);
    expect(engineReads.chains[0]?.senders.map((sender) => sender.address)).toEqual([
      firstKey,
      refundsKey,
      DEV_SOLANA_KEY,
    ]);
  });

  it('stops before writing when a new key would not share the keystore passphrase', async () => {
    const t = harness({ SIGNER_KEYSTORE_PASSPHRASE: 'the first passphrase' });
    await init(['--yes', '--chains', 'solana', '--solana-signer', 'local', '--no-start'], t.io);
    const before = t.file('.env');

    t.io.env = { ...process.env, SIGNER_KEYSTORE_PASSPHRASE: 'a different passphrase' };
    const code = await init(
      ['--yes', '--chains', 'solana,base', '--base-signer', 'local', '--no-start'],
      t.io,
    );

    expect(code).toBe(INIT_EXIT.cannotRun);
    expect(t.output()).toContain('the passphrase does not open "solana-sender"');
    expect(t.file('.env')).toBe(before);
    expect(readdirSync(path.join(t.root, 'signer/local/keystore'))).toEqual(['solana-sender.json']);
  });

  it('refuses mainnet without --confirm-mainnet, and writes nothing', async () => {
    const t = harness();
    const code = await init(
      [
        '--yes',
        '--chains',
        'base',
        '--base-network',
        'mainnet',
        '--base-signer',
        'keyfile',
        '--no-start',
      ],
      t.io,
    );
    expect(code).toBe(INIT_EXIT.cannotRun);
    expect(t.output()).toContain('--confirm-mainnet');
    expect(existsSync(path.join(t.root, '.env'))).toBe(false);
  });

  it('refuses the dev keyfile on mainnet', async () => {
    const t = harness();
    const code = await init(
      [
        '--yes',
        '--chains',
        'base',
        '--base-network',
        'mainnet',
        '--confirm-mainnet',
        '--base-signer',
        'keyfile',
        '--no-start',
      ],
      t.io,
    );
    expect(code).toBe(INIT_EXIT.cannotRun);
    expect(t.output()).toContain('keyfile');
    expect(existsSync(path.join(t.root, '.env'))).toBe(false);
  });

  it('needs the signing choice for a new chain', async () => {
    const t = harness();
    const code = await init(['--yes', '--chains', 'solana', '--no-start'], t.io);
    expect(code).toBe(INIT_EXIT.cannotRun);
    expect(t.output()).toContain('--solana-signer');
  });
});

describe('prerequisites', () => {
  it('stops before asking anything when Docker is missing, saying what to install on macOS', async () => {
    const t = harness({}, probeWithout('docker'));
    const code = await init(['--yes', '--chains', 'base', '--base-signer', 'keyfile'], t.io);
    expect(code).toBe(INIT_EXIT.cannotRun);
    expect(t.output()).toContain('Docker is not installed');
    expect(t.output()).toContain('https://docs.docker.com/desktop/setup/install/mac-install/');
    expect(t.output()).toContain('brew install --cask docker');
    expect(t.output()).toContain('--no-start');
    expect(existsSync(path.join(t.root, '.env'))).toBe(false);
  });

  it('does not need Docker under --no-start', async () => {
    expect(await findMissing(probeWithout('docker'), MAC, { needDocker: false })).toEqual([]);
  });

  it('names the package for this Linux distribution, and the daemon when it is down', async () => {
    const ubuntu: Machine = {
      platform: 'linux',
      nodeVersion: 'v22.1.0',
      linuxIds: ['ubuntu', 'debian'],
    };
    const missing = await findMissing(probeWithout('compose', 'daemon'), ubuntu, {
      needDocker: true,
    });
    expect(missing.map((m) => [m.what, m.fix])).toEqual([
      ['compose', ['sudo apt-get install -y docker-compose-plugin']],
      ['docker-running', ['sudo systemctl start docker']],
    ]);
  });

  it("gives Docker's install script on Linux, and an old Node", async () => {
    const fedora: Machine = { platform: 'linux', nodeVersion: 'v20.11.0', linuxIds: ['fedora'] };
    const missing = await findMissing(probeWithout('docker', 'pnpm'), fedora, { needDocker: true });
    expect(missing.map((m) => m.what)).toEqual(['node', 'pnpm', 'docker']);
    expect(missing[0]!.fix).toEqual(['sudo dnf install -y nodejs22']);
    expect(missing[2]!.fix[0]).toContain('https://get.docker.com');
  });

  it('points Windows at WSL', async () => {
    const windows: Machine = { platform: 'win32', nodeVersion: 'v22.1.0' };
    const [missing] = await findMissing(probeWithout('docker'), windows, { needDocker: true });
    expect(missing!.fix[0]).toContain('WSL 2');
  });
});

describe('starting the services', () => {
  it("shows a service's last log lines and the command for more when it does not come up", async () => {
    let output = '';
    const ran: string[] = [];
    const run: Runner = (command, args) => {
      ran.push([command, ...args].join(' '));
      return Promise.resolve({ code: 0, stdout: '', stderr: '' });
    };
    const readiness: Readiness = {
      container: (service) =>
        Promise.resolve(
          service === 'worker'
            ? { State: 'exited', ExitCode: 1 }
            : { State: 'running', Health: 'healthy' },
        ),
      answers: () => Promise.resolve(true),
      logs: (service) =>
        Promise.resolve(
          service === 'worker' ? 'line one\nSafe sender startup checks failed\n' : '',
        ),
    };

    const up = await startServices(
      run,
      readiness,
      plainUi({ write: (text) => (output += text) }),
      '/repo',
      {
        ownDatabase: false,
        pollMs: 1,
      },
    );

    expect(up).toBe(false);
    expect(ran).toEqual([
      'docker compose up -d --build postgres signer',
      'pnpm db:migrate',
      'docker compose up -d --build api worker',
    ]);
    expect(output).toContain('worker: its container stopped (exit code 1)');
    expect(output).toContain('Safe sender startup checks failed');
    expect(output).toContain('More: docker compose logs worker');
  });
});
