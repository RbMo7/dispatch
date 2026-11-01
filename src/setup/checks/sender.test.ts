import { describe, expect, it } from 'vitest';

import { err, ok } from '../../domain/result.js';
import type { ChainReads, CheckContext, RecentTransactions } from '../check.js';
import {
  BASE_SENDER,
  fakeContext,
  goodEnv,
  healthyChain,
  result,
  SOLANA_SENDER,
} from '../test-support/fake-context.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;

function solana(
  { balance, fee = 5000n }: { balance: bigint; fee?: bigint | 'never landed' },
  history: RecentTransactions = { count: 0, latestHashes: [] },
  env = goodEnv(),
): CheckContext {
  const base = fakeContext(env);
  return fakeContext(env, {
    database: { ...base.database, recentTransactions: () => Promise.resolve(history) },
    chain: (chain): ChainReads =>
      chain === 'solana'
        ? {
            ...healthyChain(chain),
            balance: (_address, asset) => Promise.resolve(ok({ asset, amount: String(balance) })),
            feePaid: () => Promise.resolve(fee === 'never landed' ? undefined : fee),
          }
        : healthyChain(chain),
  });
}

const hashes = (n: number) => Array.from({ length: n }, (_, i) => `sig${i}`);

describe('Sender: Fee balance', () => {
  it('passes a new install with a balance and no fee history', async () => {
    expect(await result(solana({ balance: LAMPORTS_PER_SOL }), 'sender.fees:solana')).toEqual({
      status: 'pass',
      finding: `${SOLANA_SENDER} holds 1 SOL; no fees paid in the last 24 hours to compare with`,
    });
  });

  it('only warns at zero on a new install, with the devnet airdrop', async () => {
    expect(await result(solana({ balance: 0n }), 'sender.fees:solana')).toEqual({
      status: 'warn',
      finding: `${SOLANA_SENDER} holds no SOL, so the first transaction cannot pay its fee`,
      fix: { command: `solana airdrop 1 ${SOLANA_SENDER} --url devnet` },
    });
  });

  it('fails at zero once the engine has paid fees', async () => {
    expect(
      await result(
        solana({ balance: 0n }, { count: 2, latestHashes: hashes(2) }),
        'sender.fees:solana',
      ),
    ).toMatchObject({
      status: 'fail',
      finding: `${SOLANA_SENDER} holds no SOL, so it cannot pay any fee`,
    });
  });

  it("warns when the balance would not cover the last 24 hours' fees, read from the chain", async () => {
    expect(
      await result(
        solana({ balance: 10_000n }, { count: 3, latestHashes: hashes(3) }),
        'sender.fees:solana',
      ),
    ).toMatchObject({
      status: 'warn',
      finding: `${SOLANA_SENDER} holds 0.00001 SOL, which would not cover the 0.000015 SOL in fees over 3 transactions in the last 24 hours`,
    });
  });

  it('passes when it covers them', async () => {
    expect(
      await result(
        solana({ balance: LAMPORTS_PER_SOL }, { count: 3, latestHashes: hashes(3) }),
        'sender.fees:solana',
      ),
    ).toEqual({
      status: 'pass',
      finding: `${SOLANA_SENDER} holds 1 SOL, which covers the 0.000015 SOL in fees over 3 transactions in the last 24 hours`,
    });
  });

  it('scales a sample up to the day, and says so', async () => {
    expect(
      (
        await result(
          solana({ balance: 100_000n }, { count: 40, latestHashes: hashes(20) }),
          'sender.fees:solana',
        )
      ).finding,
    ).toBe(
      `${SOLANA_SENDER} holds 0.0001 SOL, which would not cover the about 0.0002 SOL in fees over 40 transactions in the last 24 hours (from the latest 20)`,
    );
  });

  it('counts a transaction that never landed as no fee', async () => {
    expect(
      (
        await result(
          solana({ balance: 1n, fee: 'never landed' }, { count: 2, latestHashes: hashes(2) }),
          'sender.fees:solana',
        )
      ).status,
    ).toBe('pass');
  });

  it('checks the engine key, not the Safe, on a Safe Sender', async () => {
    const env = goodEnv({
      BASE_SENDER_MODE: 'safe',
      BASE_SENDER_ADDRESS: '',
      BASE_SAFE_ADDRESS: '0x84Ac281B68de095f6227050F56C74d93d294e609',
      BASE_SAFE_EXECUTOR_ADDRESS: BASE_SENDER,
    });

    expect((await result(fakeContext(env), 'sender.fees:base')).finding).toContain(BASE_SENDER);
  });

  it('warns that it could not check when the balance read fails', async () => {
    const context = fakeContext(goodEnv(), {
      chain: (chain) => ({
        ...healthyChain(chain),
        balance: () => Promise.resolve(err({ code: 'RPC_UNAVAILABLE', message: 'down' })),
      }),
    });

    expect(await result(context, 'sender.fees:solana')).toMatchObject({
      status: 'warn',
      fix: { setting: 'SOLANA_RPC_URL' },
    });
  });
});

describe('Sender: Token balances', () => {
  const withUsdc = goodEnv({
    SOLANA_KNOWN_TOKENS: 'USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6',
  });

  function holding(amount: string) {
    return fakeContext(withUsdc, {
      chain: (chain) => ({
        ...healthyChain(chain),
        balance: (_address, asset) => Promise.resolve(ok({ asset, amount })),
        tokens: () => Promise.resolve([{ symbol: 'USDC', decimals: 6 }]),
      }),
    });
  }

  it('passes with no known tokens', async () => {
    expect(await result(fakeContext(), 'sender.tokens:solana')).toEqual({
      status: 'pass',
      finding: 'no known tokens are configured',
    });
  });

  it('passes and lists what the Sender holds', async () => {
    expect((await result(holding('2500000'), 'sender.tokens:solana')).finding).toBe(
      `${SOLANA_SENDER} holds 2.5 USDC`,
    );
  });

  it('warns on a token the Sender holds none of', async () => {
    expect(await result(holding('0'), 'sender.tokens:solana')).toEqual({
      status: 'warn',
      finding: `${SOLANA_SENDER} holds no USDC, so a payment in it fails its Funding Check`,
      fix: { step: `Send USDC to ${SOLANA_SENDER}` },
    });
  });
});
