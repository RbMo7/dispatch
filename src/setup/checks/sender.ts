import { formatUnits } from 'viem';

import { solanaNetwork } from '../../api/network.js';
import type { Chain } from '../../domain/chain.js';
import {
  fail,
  pass,
  warn,
  type Check,
  type CheckContext,
  type Fix,
  type RecentTransactions,
} from '../check.js';
import { errorText, notCheckedFinding, rpcFix } from '../wording.js';
import { plural } from './configuration.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Where to get the native asset: an airdrop on devnet, otherwise a transfer done outside this machine. */
async function fundFix(
  context: CheckContext,
  chain: Chain,
  address: string,
  symbol: string,
): Promise<Fix> {
  const network = await context
    .chain(chain)
    .network()
    .catch(() => undefined);
  if (network?.chain === 'solana' && solanaNetwork(network.genesisHash) === 'devnet') {
    return { command: `solana airdrop 1 ${address} --url devnet` };
  }
  const where = network?.chain === 'base' && network.chainId === 84532 ? 'Base Sepolia ' : '';
  return { step: `Send ${where}${symbol} to ${address}` };
}

/**
 * Transactions store no fee, so this reads each sampled one's fee from the
 * chain and scales the sample to the day's count. Exact when the day has
 * no more Transactions than the sample.
 */
async function feesPaid(
  context: CheckContext,
  chain: Chain,
  recent: RecentTransactions,
): Promise<{ total: bigint; estimated: boolean } | undefined> {
  const sampled = recent.latestHashes.length;
  if (sampled === 0) return undefined;
  const fees = await Promise.all(
    recent.latestHashes.map((hash) => context.chain(chain).feePaid(hash)),
  );
  const sum = fees.reduce<bigint>((total, fee) => total + (fee ?? 0n), 0n);
  return {
    total: (sum * BigInt(recent.count)) / BigInt(sampled),
    estimated: recent.count > sampled,
  };
}

export const feeBalance: Check = {
  id: 'sender.fees',
  area: 'sender',
  title: 'Fee balance',
  runsIn: ['cli', 'worker'],
  scope: 'chain',
  appliesTo: (setup) => setup.sender !== undefined,
  run: async (context, { chain, sender }) => {
    const { feePayer, native } = sender!;
    const amount = (value: bigint) => `${formatUnits(value, native.decimals)} ${native.symbol}`;

    const balance = await context.chain(chain).balance(feePayer, native.symbol);
    if (!balance.ok) {
      return warn(notCheckedFinding(`the balance of ${feePayer} could not be read`), rpcFix(chain));
    }
    const held = BigInt(balance.value.amount);
    const fund = () => fundFix(context, chain, feePayer, native.symbol);

    let recent: RecentTransactions;
    try {
      recent = await context.database.recentTransactions(
        chain,
        new Date(context.now().getTime() - DAY_MS),
      );
    } catch (cause) {
      const finding = notCheckedFinding(
        `${feePayer} holds ${amount(held)}, but the fee history could not be read: ${errorText(cause)}`,
      );
      return warn(
        finding,
        held === 0n
          ? await fund()
          : { setting: 'DATABASE_URL', value: 'the URL of a Postgres the engine can sign in to' },
      );
    }
    if (recent.count === 0) {
      return held === 0n
        ? warn(
            `${feePayer} holds no ${native.symbol}, so the first transaction cannot pay its fee`,
            await fund(),
          )
        : pass(
            `${feePayer} holds ${amount(held)}; no fees paid in the last 24 hours to compare with`,
          );
    }
    if (held === 0n) {
      return fail(`${feePayer} holds no ${native.symbol}, so it cannot pay any fee`, await fund());
    }

    let paid: Awaited<ReturnType<typeof feesPaid>>;
    try {
      paid = await feesPaid(context, chain, recent);
    } catch (cause) {
      return warn(
        notCheckedFinding(
          `${feePayer} holds ${amount(held)}, but the fees paid could not be read from the chain: ${errorText(cause)}`,
        ),
        rpcFix(chain),
      );
    }
    if (paid === undefined || paid.total === 0n) {
      return pass(
        `${feePayer} holds ${amount(held)}; none of the last 24 hours' Transactions has landed, so no fee to compare with`,
      );
    }
    const spent = `${paid.estimated ? 'about ' : ''}${amount(paid.total)} in fees over ${plural(recent.count, 'transaction')} in the last 24 hours${paid.estimated ? ` (from the latest ${recent.latestHashes.length})` : ''}`;
    if (held < paid.total) {
      return warn(
        `${feePayer} holds ${amount(held)}, which would not cover the ${spent}`,
        await fund(),
      );
    }
    return pass(`${feePayer} holds ${amount(held)}, which covers the ${spent}`);
  },
};

export const tokenBalances: Check = {
  id: 'sender.tokens',
  area: 'sender',
  title: 'Token balances',
  runsIn: ['cli', 'worker'],
  scope: 'chain',
  appliesTo: (setup) => setup.sender !== undefined,
  run: async (context, { chain, sender }) => {
    const { address, tokens } = sender!;
    if (tokens.length === 0) return pass('no known tokens are configured');
    const reads = await Promise.all(
      tokens.map(async (token) => ({
        token,
        balance: await context.chain(chain).balance(address, token.symbol),
      })),
    );
    const unread = reads.filter(({ balance }) => !balance.ok).map(({ token }) => token.symbol);
    if (unread.length > 0) {
      return warn(
        notCheckedFinding(`the ${unread.join(', ')} balance of ${address} could not be read`),
        rpcFix(chain),
      );
    }
    const held = reads.map(({ token, balance }) => ({
      symbol: token.symbol,
      amount: balance.ok ? formatUnits(BigInt(balance.value.amount), token.decimals) : '0',
    }));
    const empty = held.filter((token) => token.amount === '0').map((token) => token.symbol);
    if (empty.length > 0) {
      return warn(
        `${address} holds no ${empty.join(', ')}, so a payment in it fails its Funding Check`,
        {
          step: `Send ${empty.join(', ')} to ${address}`,
        },
      );
    }
    return pass(`${address} holds ${held.map((t) => `${t.amount} ${t.symbol}`).join(', ')}`);
  },
};
