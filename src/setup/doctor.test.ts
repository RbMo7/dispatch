import { describe, expect, it } from 'vitest';

import type { Env } from '../config.js';
import type { CheckContext } from './check.js';
import { doctor, type DoctorIo } from './doctor.js';
import { painter, renderHuman, renderJson } from './report.js';
import type { CheckOutcome } from './run.js';
import { fakeContext, goodEnv, leakyContext } from './test-support/fake-context.js';

const FIXED: CheckOutcome[] = [
  {
    id: 'configuration.tokens',
    area: 'configuration',
    title: 'Tokens',
    result: {
      status: 'warn',
      finding: 'OPERATOR_TOKEN is not set',
      fix: { setting: 'OPERATOR_TOKEN', value: 'a random value' },
    },
  },
  {
    id: 'database.migrated',
    area: 'database',
    title: 'Migrated',
    result: {
      status: 'fail',
      finding: '1 migration not applied: 0018_signer_keys',
      fix: { command: 'pnpm db:migrate' },
    },
  },
  {
    id: 'chain.rpc:solana',
    area: 'chain',
    title: 'RPC reachable (Solana)',
    chain: 'solana',
    result: { status: 'pass', finding: 'SOLANA_RPC_URL (api.devnet.solana.com) answered' },
  },
  {
    id: 'sender.fees:solana',
    area: 'sender',
    title: 'Fee balance (Solana)',
    chain: 'solana',
    result: {
      status: 'warn',
      finding: 'abc holds no SOL',
      fix: { step: 'Send SOL to abc' },
    },
  },
];

describe('the doctor report', () => {
  it('groups by area, one labelled line per check, each fix under it, then a summary', () => {
    expect(renderHuman(FIXED, painter(false))).toBe(
      [
        'Configuration',
        '  ! WARN  Tokens                  OPERATOR_TOKEN is not set',
        '          fix: set OPERATOR_TOKEN to a random value',
        '',
        'Database',
        '  ✗ FAIL  Migrated                1 migration not applied: 0018_signer_keys',
        '          fix: run pnpm db:migrate',
        '',
        'Chain',
        '  ✓ PASS  RPC reachable (Solana)  SOLANA_RPC_URL (api.devnet.solana.com) answered',
        '',
        'Sender',
        '  ! WARN  Fee balance (Solana)    abc holds no SOL',
        '          fix: Send SOL to abc',
        '',
        '1 passed, 2 warnings, 1 problem',
        '',
      ].join('\n'),
    );
  });

  it('prints the same results as JSON', () => {
    expect(JSON.parse(renderJson(FIXED))).toEqual({
      summary: { passed: 1, warnings: 2, problems: 1 },
      checks: [
        {
          id: 'configuration.tokens',
          area: 'configuration',
          title: 'Tokens',
          status: 'warn',
          finding: 'OPERATOR_TOKEN is not set',
          fix: { setting: 'OPERATOR_TOKEN', value: 'a random value' },
        },
        {
          id: 'database.migrated',
          area: 'database',
          title: 'Migrated',
          status: 'fail',
          finding: '1 migration not applied: 0018_signer_keys',
          fix: { command: 'pnpm db:migrate' },
        },
        {
          id: 'chain.rpc:solana',
          area: 'chain',
          title: 'RPC reachable (Solana)',
          chain: 'solana',
          status: 'pass',
          finding: 'SOLANA_RPC_URL (api.devnet.solana.com) answered',
        },
        {
          id: 'sender.fees:solana',
          area: 'sender',
          title: 'Fee balance (Solana)',
          chain: 'solana',
          status: 'warn',
          finding: 'abc holds no SOL',
          fix: { step: 'Send SOL to abc' },
        },
      ],
    });
  });
});

function capture(isTTY = false) {
  let text = '';
  return {
    output: { write: (chunk: string) => (text += chunk), isTTY },
    text: () => text,
  };
}

async function run(
  args: string[],
  {
    context = fakeContext(),
    env = goodEnv(),
    isTTY = false,
  }: { context?: CheckContext; env?: Env; isTTY?: boolean } = {},
) {
  const stdout = capture(isTTY);
  const stderr = capture();
  const io: DoctorIo = {
    stdout: stdout.output,
    stderr: stderr.output,
    env,
    makeContext: () => ({ context, close: () => Promise.resolve() }),
  };
  const code = await doctor(args, io);
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const failing = () =>
  fakeContext(goodEnv(), {
    database: { ...fakeContext().database, pendingMigrations: () => Promise.resolve(['0018_x']) },
  });

describe('pnpm dispatch doctor', () => {
  it('exits 0 when nothing failed', async () => {
    const { code, stdout } = await run([]);

    expect(code).toBe(0);
    expect(stdout).toMatch(/\d+ passed, 0 warnings, 0 problems\n$/);
  });

  it('exits 1 when a check failed, naming it with its fix', async () => {
    const { code, stdout } = await run([], { context: failing() });

    expect(code).toBe(1);
    expect(stdout).toContain('✗ FAIL  Migrated');
    expect(stdout).toContain('fix: run pnpm db:migrate');
  });

  it.each([[['--only', 'galaxy']], [['--loud']], [['--only']]])(
    'exits 2 on bad arguments %j',
    async (args) => {
      const { code, stderr } = await run(args);

      expect(code).toBe(2);
      expect(stderr).toContain('Usage: pnpm dispatch doctor');
    },
  );

  it('exits 2 when it cannot build what the checks read', async () => {
    const stderr = capture();
    const code = await doctor([], {
      stdout: capture().output,
      stderr: stderr.output,
      env: goodEnv(),
      makeContext: () => {
        throw new Error('no such file');
      },
    });

    expect(code).toBe(2);
    expect(stderr.text()).toBe('doctor could not start: no such file\n');
  });

  it('prints JSON with --json', async () => {
    const { code, stdout } = await run(['--json'], { context: failing() });
    const report = JSON.parse(stdout) as { summary: { problems: number } };

    expect(code).toBe(1);
    expect(report.summary.problems).toBe(1);
  });

  it('runs one area with --only', async () => {
    const { stdout } = await run(['--json', '--only', 'database']);
    const report = JSON.parse(stdout) as { checks: { area: string }[] };

    expect(new Set(report.checks.map((check) => check.area))).toEqual(new Set(['database']));
  });

  it('colours only a terminal, and never with NO_COLOR', async () => {
    expect((await run([], { isTTY: false })).stdout).not.toContain('\x1b[');
    expect((await run([], { isTTY: true, env: goodEnv({ NO_COLOR: '1' }) })).stdout).not.toContain(
      '\x1b[32m',
    );
    expect((await run([], { isTTY: true })).stdout).toContain('\x1b[32m✓ PASS\x1b[39m');
  });

  it('prints no secret, in either format', async () => {
    const { context, secrets } = leakyContext();

    const human = await run([], { context, env: context.env, isTTY: true });
    const json = await run(['--json'], { context, env: context.env });

    expect(human.code).toBe(1);
    for (const secret of secrets) {
      expect(human.stdout + human.stderr).not.toContain(secret);
      expect(json.stdout + json.stderr).not.toContain(secret);
    }
  });
});
