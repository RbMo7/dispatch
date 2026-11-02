import { randomBytes } from 'node:crypto';

import { configFrom, type Env } from '../../config.js';
import type { Chain } from '../../domain/chain.js';
import { ok } from '../../domain/result.js';
import type { CheckContext, CheckResult, ChainReads } from '../check.js';
import { CHECKS } from '../checks.js';
import { planChecks, runPlanned, type CheckOutcome } from '../run.js';
import { readSettings } from '../settings.js';

export const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export const SOLANA_SENDER = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';
export const BASE_SENDER = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';

export function token(): string {
  return randomBytes(24).toString('hex');
}

/** An environment every check passes on, with fresh random tokens. */
export function goodEnv(overrides: Env = {}): Env {
  return {
    DATABASE_URL: 'postgres://dispatch:dispatch@localhost:5432/dispatch',
    ENABLED_CHAINS: 'solana,base',
    AUTH_TOKEN: token(),
    OPERATOR_TOKEN: token(),
    SIGNER_AUTH_TOKEN: token(),
    SOLANA_RPC_URL: 'https://api.devnet.solana.com',
    SOLANA_SENDER_ADDRESS: SOLANA_SENDER,
    BASE_RPC_URL: 'https://sepolia.base.org',
    BASE_CHAIN_ID: '84532',
    BASE_SENDER_ADDRESS: BASE_SENDER,
    ...overrides,
  };
}

export function healthyChain(chain: Chain): ChainReads {
  return {
    network: () =>
      Promise.resolve(
        chain === 'solana'
          ? { chain: 'solana', genesisHash: DEVNET_GENESIS }
          : { chain: 'base', chainId: 84532 },
      ),
    balance: (_address, asset) => Promise.resolve(ok({ asset, amount: '5000000000' })),
    feePaid: () => Promise.resolve(5000n),
  };
}

/**
 * A context whose every read succeeds; a test overrides the one it is about.
 * `senders` is a senders file's JSON (ADR-0060); without it, the variables
 * describe the Senders, whatever files the working directory holds.
 */
export function fakeContext(
  env: Env = goodEnv(),
  overrides: Partial<Omit<CheckContext, 'env' | 'config' | 'settings'>> = {},
  senders?: unknown,
): CheckContext {
  const config = configFrom(env);
  return {
    env,
    config,
    settings: readSettings(config, () =>
      senders === undefined
        ? { kind: 'variables' }
        : { kind: 'file', path: 'senders.json', text: JSON.stringify(senders) },
    ),
    database: {
      ping: () => Promise.resolve(),
      pendingMigrations: () => Promise.resolve([]),
      recentTransactions: () => Promise.resolve({ count: 0, latestHashes: [] }),
    },
    chain: healthyChain,
    signer: {
      readPins: (address) => Promise.resolve({ kind: 'pins', pins: { address, curve: 'ed25519' } }),
    },
    multisigStartup: () => Promise.resolve({ failures: [], warnings: [] }),
    apiEnvironment: () =>
      Promise.resolve({ source: 'compose', env: { SIGNER_URL: '', SIGNER_AUTH_TOKEN: '' } }),
    consoleBuilt: () => true,
    now: () => new Date('2026-11-01T12:00:00Z'),
    ...overrides,
  };
}

export async function outcomes(context: CheckContext): Promise<CheckOutcome[]> {
  return runPlanned(planChecks(CHECKS, context, { place: 'cli' }));
}

export async function result(context: CheckContext, id: string): Promise<CheckResult> {
  const found = (await outcomes(context)).find((outcome) => outcome.id === id);
  if (!found) throw new Error(`no outcome for ${id}`);
  return found.result;
}

/**
 * A setup whose every secret is a fresh random token, and whose every read
 * fails with an error that repeats the URL holding it, the way real client
 * errors do. Nothing reported from it may contain any of `secrets`.
 */
export function leakyContext(): { context: CheckContext; secrets: string[] } {
  const [auth, dbPassword, solanaKey, baseKey, signerToken, safeKey, signerPassword] = Array.from(
    { length: 7 },
    token,
  ) as [string, string, string, string, string, string, string];
  const signerUrl = `http://ops:${signerPassword}@signer.internal:8421`;
  const env = goodEnv({
    AUTH_TOKEN: auth,
    OPERATOR_TOKEN: auth,
    SIGNER_URL: signerUrl,
    SIGNER_AUTH_TOKEN: signerToken,
    DATABASE_URL: `postgres://dispatch:${dbPassword}@db.internal:5432/dispatch`,
    SOLANA_RPC_URL: `https://rpc.example.com/?api-key=${solanaKey}`,
    BASE_RPC_URL: `https://base.example.com/v2/${baseKey}`,
    BASE_SENDER_MODE: 'safe',
    BASE_SENDER_ADDRESS: '',
    BASE_SAFE_ADDRESS: '0x84Ac281B68de095f6227050F56C74d93d294e609',
    BASE_SAFE_EXECUTOR_ADDRESS: BASE_SENDER,
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
    signer: {
      readPins: () =>
        Promise.resolve({
          kind: 'unreachable',
          message: `failed to reach signer at ${signerUrl}: connect ECONNREFUSED`,
        }),
    },
    multisigStartup: () =>
      Promise.resolve({
        failures: [
          {
            check: 'safe readable',
            message: `could not read the Safe: request to ${env.BASE_RPC_URL} failed`,
          },
          {
            check: 'signer can sign for the executor',
            message: `could not ask the Signer: failed to reach signer at ${signerUrl}`,
          },
        ],
        warnings: [],
      }),
    apiEnvironment: () => Promise.resolve({ source: 'process', env }),
  });
  return {
    context,
    secrets: [auth, dbPassword, solanaKey, baseKey, signerToken, safeKey, signerPassword],
  };
}
