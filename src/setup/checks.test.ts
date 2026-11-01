import { describe, expect, it } from 'vitest';

import type { CheckContext, CheckResult } from './check.js';
import { CHECKS } from './checks.js';
import { planChecks, runPlanned, type CheckOutcome } from './run.js';
import { fakeContext, goodEnv, healthyChain, token } from './test-support/fake-context.js';

async function outcomes(context: CheckContext): Promise<CheckOutcome[]> {
  return runPlanned(planChecks(CHECKS, context, { place: 'cli' }));
}

async function result(context: CheckContext, id: string): Promise<CheckResult> {
  const found = (await outcomes(context)).find((outcome) => outcome.id === id);
  if (!found) throw new Error(`no outcome for ${id}`);
  return found.result;
}

describe('setup checks', () => {
  it('pass on a healthy setup', async () => {
    const all = await outcomes(fakeContext());

    expect(all.filter((o) => o.result.status !== 'pass')).toEqual([]);
    expect(all.map((o) => o.id)).toEqual(
      expect.arrayContaining(['chain.rpc:solana', 'chain.rpc:base', 'chain.network:base']),
    );
  });

  it('have unique ids', () => {
    expect(new Set(CHECKS.map((check) => check.id)).size).toBe(CHECKS.length);
  });

  describe('Environment parses', () => {
    it('reports every problem at once, each by its variable', async () => {
      const context = fakeContext(
        goodEnv({
          ENABLED_CHAINS: 'solana,base,evm',
          SOLANA_RPC_URL: 'not a url',
          BASE_CHAIN_ID: 'abc',
          SOLANA_KNOWN_TOKENS: 'USDC:mint',
          BASE_SENDER_MODE: 'safe',
        }),
      );

      const checked = await result(context, 'configuration.environment');

      expect(checked.status).toBe('fail');
      for (const variable of [
        'ENABLED_CHAINS',
        'SOLANA_RPC_URL',
        'BASE_CHAIN_ID',
        'SOLANA_KNOWN_TOKENS',
        'BASE_SAFE_ADDRESS',
        'BASE_SAFE_EXECUTOR_ADDRESS',
      ]) {
        expect(checked.finding).toContain(variable);
      }
      expect(checked).toMatchObject({
        fix: { setting: expect.stringContaining('SOLANA_RPC_URL') as string },
      });
    });

    it('runs no chain-specific check on a chain whose settings are broken', () => {
      const context = fakeContext(goodEnv({ SOLANA_KNOWN_TOKENS: 'bad' }));

      expect(context.settings.chains.find((c) => c.chain === 'solana')).toEqual({
        chain: 'solana',
      });
    });
  });

  describe('Tokens', () => {
    it('warns while OPERATOR_TOKEN is unset', async () => {
      expect(
        await result(fakeContext(goodEnv({ OPERATOR_TOKEN: undefined })), 'configuration.tokens'),
      ).toMatchObject({ status: 'warn', fix: { setting: 'OPERATOR_TOKEN' } });
    });

    it.each([
      ['the development default', { AUTH_TOKEN: 'dev-secret' }, 'AUTH_TOKEN'],
      ['an unset AUTH_TOKEN', { AUTH_TOKEN: undefined }, 'AUTH_TOKEN'],
      ['a short AUTH_TOKEN', { AUTH_TOKEN: 'short' }, 'AUTH_TOKEN'],
      ['a short OPERATOR_TOKEN', { OPERATOR_TOKEN: 'short' }, 'OPERATOR_TOKEN'],
    ])('fails on %s', async (_, overrides, setting) => {
      expect(await result(fakeContext(goodEnv(overrides)), 'configuration.tokens')).toMatchObject({
        status: 'fail',
        fix: { setting, value: expect.stringContaining('openssl rand -hex 32') as string },
      });
    });

    it('fails when OPERATOR_TOKEN is AUTH_TOKEN', async () => {
      const shared = token();
      const checked = await result(
        fakeContext(goodEnv({ AUTH_TOKEN: shared, OPERATOR_TOKEN: shared })),
        'configuration.tokens',
      );

      expect(checked).toMatchObject({ status: 'fail', fix: { setting: 'OPERATOR_TOKEN' } });
      expect(checked.finding).toContain('same as AUTH_TOKEN');
    });
  });

  describe('Enabled chains', () => {
    it('warns when no chain is enabled', async () => {
      expect(
        await result(fakeContext(goodEnv({ ENABLED_CHAINS: '' })), 'configuration.chains'),
      ).toMatchObject({ status: 'warn', fix: { setting: 'ENABLED_CHAINS' } });
    });

    it('fails on an enabled chain without a Sender', async () => {
      expect(
        await result(fakeContext(goodEnv({ SOLANA_SENDER_ADDRESS: '' })), 'configuration.chains'),
      ).toMatchObject({
        status: 'fail',
        finding: 'solana is enabled but SOLANA_SENDER_ADDRESS is empty',
        fix: { setting: 'SOLANA_SENDER_ADDRESS' },
      });
    });

    it('warns about a Sender for a chain that is not enabled', async () => {
      expect(
        await result(fakeContext(goodEnv({ ENABLED_CHAINS: 'solana' })), 'configuration.chains'),
      ).toMatchObject({
        status: 'warn',
        finding: 'BASE_SENDER_ADDRESS is set but base is not in ENABLED_CHAINS',
        fix: { setting: 'ENABLED_CHAINS', value: 'solana,base' },
      });
    });
  });

  describe('Database', () => {
    it('fails when nothing listens, with the command that starts Postgres', async () => {
      const context = fakeContext(goodEnv(), {
        database: {
          ...fakeContext().database,
          ping: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:5432')),
        },
      });

      expect(await result(context, 'database.reachable')).toMatchObject({
        status: 'fail',
        fix: { command: 'docker compose up -d postgres' },
      });
    });

    it('fails on refused credentials, pointing at DATABASE_URL', async () => {
      const context = fakeContext(goodEnv(), {
        database: {
          ...fakeContext().database,
          ping: () => Promise.reject(new Error('password authentication failed for user "x"')),
        },
      });

      expect(await result(context, 'database.reachable')).toMatchObject({
        status: 'fail',
        fix: { setting: 'DATABASE_URL' },
      });
    });

    it('fails on unapplied migrations, naming them', async () => {
      const context = fakeContext(goodEnv(), {
        database: {
          ...fakeContext().database,
          pendingMigrations: () => Promise.resolve(['0017_a', '0018_b']),
        },
      });

      expect(await result(context, 'database.migrated')).toEqual({
        status: 'fail',
        finding: '2 migrations not applied: 0017_a, 0018_b',
        fix: { command: 'pnpm db:migrate' },
      });
    });

    it('warns that migrations went unchecked when the database is down', async () => {
      const context = fakeContext(goodEnv(), {
        database: {
          ...fakeContext().database,
          pendingMigrations: () => Promise.reject(new Error('connect ECONNREFUSED')),
        },
      });

      expect(await result(context, 'database.migrated')).toMatchObject({ status: 'warn' });
    });
  });

  describe('Chain', () => {
    it('fails an RPC that does not answer, per chain', async () => {
      const context = fakeContext(goodEnv(), {
        chain: (chain) =>
          chain === 'base'
            ? { ...healthyChain(chain), network: () => Promise.reject(new Error('fetch failed')) }
            : healthyChain(chain),
      });

      expect(await result(context, 'chain.rpc:base')).toMatchObject({
        status: 'fail',
        finding: 'BASE_RPC_URL (sepolia.base.org) did not answer: fetch failed',
        fix: { setting: 'BASE_RPC_URL' },
      });
      expect((await result(context, 'chain.rpc:solana')).status).toBe('pass');
      expect((await result(context, 'chain.network:base')).status).toBe('warn');
    });

    it('fails a Base RPC serving another chain than BASE_CHAIN_ID', async () => {
      const context = fakeContext(goodEnv(), {
        chain: (chain) =>
          chain === 'base'
            ? { ...healthyChain(chain), network: () => Promise.resolve({ chain, chainId: 8453 }) }
            : healthyChain(chain),
      });

      expect(await result(context, 'chain.network:base')).toEqual({
        status: 'fail',
        finding: 'BASE_RPC_URL serves chain 8453, but BASE_CHAIN_ID is 84532',
        fix: {
          setting: 'BASE_RPC_URL',
          value: 'an RPC for chain 84532 (BASE_CHAIN_ID), or set BASE_CHAIN_ID=8453',
        },
      });
    });

    it('warns on a Solana cluster it does not recognise', async () => {
      const context = fakeContext(goodEnv(), {
        chain: (chain) =>
          chain === 'solana'
            ? {
                ...healthyChain(chain),
                network: () => Promise.resolve({ chain, genesisHash: 'localvalidator' }),
              }
            : healthyChain(chain),
      });

      expect(await result(context, 'chain.network:solana')).toMatchObject({
        status: 'warn',
        fix: { setting: 'SOLANA_RPC_URL' },
      });
    });

    it('names the cluster it found', async () => {
      expect(await result(fakeContext(), 'chain.network:solana')).toEqual({
        status: 'pass',
        finding: 'SOLANA_RPC_URL serves devnet',
      });
    });
  });

  describe('Console', () => {
    it('warns when the console is not built, with the build command', async () => {
      expect(
        await result(fakeContext(goodEnv(), { consoleBuilt: () => false }), 'console.built'),
      ).toEqual({
        status: 'warn',
        finding: 'web/dist/engine is missing, so the API serves no console',
        fix: { command: 'pnpm --dir web install && pnpm --dir web build' },
      });
    });
  });

  it('never puts a secret in a finding or a fix', async () => {
    const secrets = Array.from({ length: 6 }, token);
    const [auth, dbPassword, solanaKey, baseKey, signerToken, safeKey] = secrets as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const env = goodEnv({
      AUTH_TOKEN: auth,
      OPERATOR_TOKEN: auth,
      SIGNER_AUTH_TOKEN: signerToken,
      DATABASE_URL: `postgres://dispatch:${dbPassword}@db.internal:5432/dispatch`,
      SOLANA_RPC_URL: `https://rpc.example.com/?api-key=${solanaKey}`,
      BASE_RPC_URL: `https://base.example.com/v2/${baseKey}`,
      BASE_SAFE_API_KEY: safeKey,
    });
    const leak = (url: string) => () => Promise.reject(new Error(`request to ${url} failed`));
    const context = fakeContext(env, {
      database: {
        ping: leak(env.DATABASE_URL!),
        pendingMigrations: leak(env.DATABASE_URL!),
        recentTransactions: leak(env.DATABASE_URL!),
      },
      chain: (chain) => ({
        ...healthyChain(chain),
        network: leak(chain === 'solana' ? env.SOLANA_RPC_URL! : env.BASE_RPC_URL!),
      }),
    });

    const reported = JSON.stringify(await outcomes(context));

    expect(reported).toContain('"status":"fail"');
    for (const secret of secrets) expect(reported).not.toContain(secret);
  });
});

describe('the check runner', () => {
  it('fails a check that does not finish in time, without holding up the rest', async () => {
    const context = fakeContext(goodEnv(), {
      database: { ...fakeContext().database, ping: () => new Promise(() => {}) },
    });
    const started = Date.now();

    const all = await runPlanned(planChecks(CHECKS, context, { place: 'cli' }), {
      timeoutMs: 200,
    });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(all.find((o) => o.id === 'database.reachable')?.result).toMatchObject({
      status: 'fail',
      finding: 'did not finish within 0.2s',
    });
    expect(all.find((o) => o.id === 'database.migrated')?.result.status).toBe('pass');
  });

  it('fails a check that throws, and runs the others', async () => {
    const context = fakeContext(goodEnv(), {
      consoleBuilt: () => {
        throw new Error('disk gone');
      },
    });

    const all = await outcomes(context);

    expect(all.find((o) => o.id === 'console.built')?.result).toMatchObject({
      status: 'fail',
      finding: 'the check itself failed: disk gone',
    });
    expect(all.filter((o) => o.result.status === 'fail')).toHaveLength(1);
  });

  it('runs only the checks of one area, and only those for its place', () => {
    const context = fakeContext();

    expect(planChecks(CHECKS, context, { place: 'cli', only: 'chain' }).map((p) => p.id)).toEqual([
      'chain.rpc:solana',
      'chain.rpc:base',
      'chain.network:solana',
      'chain.network:base',
    ]);
    expect(planChecks(CHECKS, context, { place: 'worker' }).map((p) => p.id)).not.toContain(
      'console.built',
    );
  });
});
