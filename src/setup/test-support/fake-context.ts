import { randomBytes } from 'node:crypto';

import { configFrom, type Env } from '../../config.js';
import type { Chain } from '../../domain/chain.js';
import { ok } from '../../domain/result.js';
import type { CheckContext, ChainReads } from '../check.js';
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

/** A context whose every read succeeds; a test overrides the one it is about. */
export function fakeContext(
  env: Env = goodEnv(),
  overrides: Partial<Omit<CheckContext, 'env' | 'config' | 'settings'>> = {},
): CheckContext {
  const config = configFrom(env);
  return {
    env,
    config,
    settings: readSettings(config),
    database: {
      ping: () => Promise.resolve(),
      pendingMigrations: () => Promise.resolve([]),
      recentTransactions: () => Promise.resolve({ count: 0, latestHashes: [] }),
    },
    chain: healthyChain,
    consoleBuilt: () => true,
    now: () => new Date('2026-11-01T12:00:00Z'),
    ...overrides,
  };
}
