import { formatAmount, type Money } from '../domain/assets';
import { type Chain, type Network, txLink } from '../domain/chains';
import type { DispatchSummary, Item, ItemStatus } from '../domain/dispatch';
import type { Flow, Stage } from '../domain/flow';

export const FIXTURE_TODAY = new Date(2026, 9, 31);

function at(day: 0 | 1, time: string): Date {
  const [h, m, s] = time.split(':').map(Number);
  return new Date(2026, 9, 31 - day, h, m, s ?? 0);
}

function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEX = '0123456789abcdef';
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function chars(rand: () => number, alphabet: string, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

function address(rand: () => number, chain: Chain): string {
  return chain === 'base' ? `0x${chars(rand, HEX, 40)}` : chars(rand, BASE58, 44);
}

function txHash(rand: () => number, chain: Chain): string {
  return chain === 'base' ? `0x${chars(rand, HEX, 64)}` : chars(rand, BASE58, 88);
}

const DECIMALS = { USDC: 6, SOL: 9, ETH: 18 } as const;
type FixtureAsset = keyof typeof DECIMALS;

function money(decimal: string, asset: FixtureAsset): Money {
  const decimals = DECIMALS[asset];
  const [whole, fraction = ''] = decimal.split('.');
  const raw = BigInt(`${whole}${fraction.padEnd(decimals, '0')}`).toString();
  return { raw, decimals, asset };
}

function split(rand: () => number, total: Money, count: number): Money[] {
  const units = BigInt(total.raw);
  const weights = Array.from({ length: count }, () => 0.15 + rand() ** 2);
  const sum = weights.reduce((a, b) => a + b, 0);
  const parts = weights.map((w) => (BigInt(Math.floor((w / sum) * 1e9)) * units) / 1_000_000_000n);
  parts[0]! += units - parts.reduce((a, b) => a + b, 0n);
  return parts.map((part) => ({ ...total, raw: part.toString() }));
}

interface ItemPlan {
  seed: number;
  chain: Chain;
  total: Money;
  runs: [ItemStatus, number][];
  sharedHash?: string;
  failures?: Record<number, { code: string; message: string }>;
}

function makeItems(plan: ItemPlan): Item[] {
  const rand = random(plan.seed);
  const statuses = plan.runs.flatMap(([status, n]) => Array<ItemStatus>(n).fill(status));
  const amounts = split(rand, plan.total, statuses.length);
  return statuses.map((status, index) => {
    const sent = status === 'broadcasting' || status === 'confirmed';
    return {
      index,
      type: 'payment',
      recipient: address(rand, plan.chain),
      asset: plan.total.asset,
      amount: amounts[index]!,
      approval: null,
      status,
      transactionHash: sent ? (plan.sharedHash ?? txHash(rand, plan.chain)) : null,
      error: status === 'failed' ? (plan.failures?.[index] ?? null) : null,
    };
  });
}

const H1 = '0x19c2be07f4a1d3c58e2b9a60d71f3c4e8a5b2d07e6c1f94a3b8d2e70c5a1f9d0e';
const H4 = '0x3e9d4c71aa02f86b1d5e9c37b40e2f18c6a9d5b210e4f7a8c3d1b6e9f0a2c41';
const H5 = '0x8d03f2a95c4e71b6d0a2e9f83c51b7d4e6a0c1f93b2e8d7a4c6f1e0b9d3a5c72';
const SENDER_BASE = '0x8b21c4e09f7a3d56b1e2c8f0a4d97e3b6c5144fe';
const SENDER_SOL = '9wFd3kQe7RzXbN2pLmV8cTyH5sJaG4uWnE1oKiD6mT3a';
const VAULT = 'Gx7kP2mWqR9tVbN4cLs8YdE3fHj6UaZ1oXeK5iMvQ2rv';

const INVALID_RECIPIENT = {
  code: 'INVALID_RECIPIENT',
  message: 'The address has no code and the token refuses it. Nothing was spent.',
};

/** A Dispatch as the board recorded it: the list row, its items and flow, plus a label. */
export interface GalleryDispatch extends DispatchSummary {
  label: string;
  when: string;
  retryPolicy: string;
  bulkCall: string;
  claimedAt: Date | null;
  idempotencyKey: string;
  items: Item[];
  flow: Flow;
}

/** The board shows each chain's mainnet. */
export const BOARD_NETWORK: Record<Chain, Network> = { solana: 'mainnet-beta', base: 'base' };

const explorer = (chain: Chain, hash: string) => txLink(BOARD_NETWORK[chain], hash)!;

function stage(
  kind: Stage['kind'],
  title: string,
  atTime: string,
  detail?: string,
  extra?: Partial<Stage>,
): Stage {
  return { kind, title, ...(atTime && { at: atTime }), ...(detail && { detail }), ...extra };
}

const LARGE_ITEMS = makeItems({
  seed: 1000,
  chain: 'base',
  total: money('184326.71', 'USDC'),
  runs: [
    ['confirmed', 300],
    ['failed', 1],
    ['confirmed', 210],
    ['failed', 1],
    ['confirmed', 102],
    ['broadcasting', 25],
    ['failed', 1],
    ['queued', 360],
  ],
  failures: {
    300: INVALID_RECIPIENT,
    511: { code: 'INVALID_RECIPIENT', message: 'The address is the zero address.' },
    639: {
      code: 'CHAIN_REJECTED',
      message: 'execution reverted: ERC20: transfer to a blocked address',
    },
  },
});

export const DISPATCHES: GalleryDispatch[] = [
  {
    id: '7f3a91c2',
    label: 'Contractor payouts',
    mode: 'managed',
    chain: 'base',
    status: 'broadcasting',
    createdAt: at(0, '14:02:11'),
    when: 'Today, 14:02',
    itemCount: 37,
    totals: [money('12480.00', 'USDC')],
    sender: { name: 'payouts', address: SENDER_BASE },
    retryPolicy: 'On, up to 5 fee bumps',
    bulkCall: 'Yes, through the aggregator',
    claimedAt: at(0, '14:02:12'),
    idempotencyKey: 'payroll-2026-10-31-contractors',
    items: makeItems({
      seed: 37,
      chain: 'base',
      total: money('12480.00', 'USDC'),
      runs: [['broadcasting', 37]],
      sharedHash: H1,
    }),
    flow: {
      summary: 'Stage 5 of 6, waiting for a block',
      elapsed: '1 min 41 s so far',
      stages: [
        stage('done', 'Submitted', '14:02:11', '37 payments through the API'),
        stage(
          'done',
          'Claimed',
          '14:02:12',
          'Funding Check passed: 12,480.00 USDC needed, 31,906.44 held',
        ),
        stage('done', 'Signed', '14:02:13', 'AWS KMS key 0x8b21…44fe, nonce 1,204'),
        stage('done', 'Sent', '14:02:14', 'Bulk Call through the aggregator, 0x7f3a…2a41'),
        stage(
          'branch-done',
          'Fee bumped',
          '14:03:15',
          'No block after 60 s, so both fees went up 15%. Replacement 0x19c2…d07e at the same nonce.',
        ),
        stage(
          'current',
          'Confirming',
          'now',
          'Watching both versions. Whichever lands first settles all 37 payments.',
        ),
        stage(
          'end-todo',
          'Transaction hash',
          '',
          `Shown here once a version lands. Until then the latest is ${H1.slice(0, 10)}…`,
        ),
      ],
    },
  },
  {
    id: 'a40d6e93',
    label: 'Weekly creator payouts',
    mode: 'managed',
    chain: 'base',
    status: 'broadcasting',
    createdAt: at(0, '13:20:04'),
    when: 'Today, 13:20',
    itemCount: 1000,
    totals: [money('184326.71', 'USDC')],
    sender: { name: 'payouts', address: SENDER_BASE },
    retryPolicy: 'On, up to 5 fee bumps',
    bulkCall: 'No, one transaction per payment',
    claimedAt: at(0, '13:20:05'),
    idempotencyKey: 'creator-payouts-2026-w44',
    items: LARGE_ITEMS,
    flow: {
      summary: 'Stage 4 of 5, 612 of 1,000 confirmed',
      elapsed: '43 min 48 s so far',
      stages: [
        stage('done', 'Submitted', '13:20:04', '1,000 payments through the API'),
        stage(
          'done',
          'Claimed',
          '13:20:05',
          'Funding Check passed: 184,326.71 USDC needed, 231,906.44 held',
        ),
        stage(
          'current',
          'Signed and sent',
          'now',
          'Nonces 1,205 onward, eight in flight at a time',
          {
            count: { reached: 640, of: 1000 },
          },
        ),
        stage(
          'branch-failed',
          'Item failures, 3',
          '13:41:27',
          'Two recipients refused and one transfer reverted. The rest carry on.',
          {
            links: [{ label: 'Show in Items', items: 'failed' }],
          },
        ),
        stage('current', 'Confirmed', 'now', 'Each payment counts once its block is final', {
          count: { reached: 612, of: 1000 },
        }),
        stage('end-todo', '1,000 transaction hashes', '', '640 sent so far. The first one:', {
          hash: LARGE_ITEMS[0]!.transactionHash!,
          links: [
            explorer('base', LARGE_ITEMS[0]!.transactionHash!),
            { label: 'Show all in Items', items: 'all' },
          ],
        }),
      ],
    },
  },
  {
    id: 'c09e5d17',
    label: 'Grant tranche 4',
    mode: 'managed',
    chain: 'solana',
    status: 'awaiting_approval',
    createdAt: at(0, '11:47:03'),
    when: 'Today, 11:47',
    itemCount: 6,
    totals: [money('48000.00', 'USDC')],
    sender: { name: 'treasury', address: VAULT },
    retryPolicy: 'Off',
    bulkCall: 'Not applicable',
    claimedAt: at(0, '11:47:04'),
    idempotencyKey: 'grants-q4-tranche-4',
    items: makeItems({
      seed: 6,
      chain: 'solana',
      total: money('48000.00', 'USDC'),
      runs: [['awaiting_approval', 6]],
    }),
    flow: {
      summary: 'Stage 4 of 7, waiting on Approvers',
      elapsed: '2 h 31 min so far',
      stages: [
        stage('done', 'Submitted', '11:47:03', '6 payments through the API'),
        stage(
          'done',
          'Claimed',
          '11:47:04',
          'Funding Check passed on the vault and the member key',
        ),
        stage('done', 'Proposed', '11:47:06', 'Proposal 41 in Squads holds all 6 transfers'),
        stage(
          'current',
          '1 of 2 approved, 1 more needed',
          '11:52:40',
          'Deadline in 66 hours. The engine never approves.',
          {
            approvers: [
              {
                address: 'zAiRHXjdotsPGWYtDNkpX3oB88vDCoSPJHv9x9gCbh9',
                label: 'Amara, finance',
                decision: 'approved',
              },
              {
                address: '7ehshELJsZhwe1P2JitpkHTwDrG97f9VH2sjNjZjC37b',
                label: 'Tomasz, operations',
                decision: 'pending',
              },
              {
                address: 'GcqC2kbm3iVTypazwt8jTsaPoWpsMgDZLYPxE7XkQpY9',
                label: null,
                decision: 'pending',
              },
            ],
            links: [{ label: 'Open proposal 41 in Squads', href: 'https://app.squads.so' }],
          },
        ),
        stage('todo', 'Executed', '', 'The engine executes once the threshold is met'),
        stage('todo', 'Confirmed', ''),
        stage('end-todo', 'Transaction hash', '', 'Appears after execution'),
      ],
    },
  },
  {
    id: '2b6f0a88',
    label: 'Creator rewards',
    mode: 'managed',
    chain: 'solana',
    status: 'held',
    createdAt: at(0, '09:15:22'),
    when: 'Today, 09:15',
    itemCount: 128,
    totals: [money('3215.50', 'USDC')],
    sender: { name: 'payouts', address: SENDER_SOL },
    retryPolicy: 'Off',
    bulkCall: 'Not applicable',
    claimedAt: null,
    idempotencyKey: 'rewards-2026-10-31',
    items: makeItems({
      seed: 128,
      chain: 'solana',
      total: money('3215.50', 'USDC'),
      runs: [['queued', 128]],
    }),
    flow: {
      summary: 'Stage 2 of 6, held for review',
      elapsed: 'Held for 4 h 58 min',
      stages: [
        stage('done', 'Submitted', '09:15:22', '128 payments through the API'),
        stage(
          'current',
          'Held',
          '09:15:22',
          'Matched "First-time recipient" for 4 addresses. Nothing has been signed.',
          {
            links: [{ label: 'Review and release', href: '#held' }],
          },
        ),
        stage('todo', 'Claimed', ''),
        stage('todo', 'Signed and sent', ''),
        stage('todo', 'Confirmed', ''),
        stage('end-todo', 'Transaction hash', ''),
      ],
    },
  },
  {
    id: 'e41c7b90',
    label: 'Gas top-up',
    mode: 'managed',
    chain: 'base',
    status: 'confirmed',
    createdAt: at(0, '08:30:41'),
    when: 'Today, 08:30',
    itemCount: 1,
    totals: [money('0.2500', 'ETH')],
    sender: { name: 'payouts', address: SENDER_BASE },
    retryPolicy: 'Off',
    bulkCall: 'No',
    claimedAt: at(0, '08:30:42'),
    idempotencyKey: 'gas-topup-relayer-7',
    items: makeItems({
      seed: 1,
      chain: 'base',
      total: money('0.2500', 'ETH'),
      runs: [['confirmed', 1]],
      sharedHash: H4,
    }),
    flow: {
      summary: 'Done in 8 s',
      elapsed: 'Confirmed at 08:30:49',
      stages: [
        stage('done', 'Submitted', '08:30:41', '1 payment through the API'),
        stage('done', 'Claimed', '08:30:42', 'Funding Check passed'),
        stage('done', 'Signed', '08:30:43', 'AWS KMS key 0x8b21…44fe, nonce 1,198'),
        stage('done', 'Sent', '08:30:44', 'Accepted by the node on the first attempt'),
        stage('done', 'Confirmed', '08:30:49', 'Block 21,604,377, now 412 blocks deep'),
        stage('end-done', 'Transaction hash', '', undefined, {
          hash: H4,
          links: [explorer('base', H4)],
        }),
      ],
    },
  },
  {
    id: '91d4e2a6',
    label: 'Vendor invoices',
    mode: 'managed',
    chain: 'base',
    status: 'partial',
    createdAt: at(1, '17:58:09'),
    when: 'Yesterday, 17:58',
    itemCount: 14,
    totals: [money('6904.12', 'USDC')],
    sender: { name: 'payouts', address: SENDER_BASE },
    retryPolicy: 'Off',
    bulkCall: 'No, one transaction per payment',
    claimedAt: at(1, '17:58:10'),
    idempotencyKey: 'ap-run-2026-10-30',
    items: makeItems({
      seed: 14,
      chain: 'base',
      total: money('6904.12', 'USDC'),
      runs: [
        ['confirmed', 8],
        ['failed', 1],
        ['confirmed', 5],
      ],
      failures: { 8: INVALID_RECIPIENT },
    }),
    flow: {
      summary: '13 of 14 confirmed',
      elapsed: 'Finished at 17:59:31',
      stages: [
        stage('done', 'Submitted', '17:58:09', '14 payments through the API'),
        stage('done', 'Claimed', '17:58:10', 'Funding Check passed'),
        stage('done', 'Signed and sent', '17:58:12', '14 transactions, nonces 1,180 to 1,193'),
        stage(
          'branch-failed',
          'Item 9 failed',
          '17:58:12',
          'INVALID_RECIPIENT: the address has no code and the token refuses it. Nothing was spent.',
          {
            links: [{ label: 'Show in Items', items: 'failed' }],
          },
        ),
        stage('done', 'Confirmed', '17:59:31', '13 transactions, blocks 21,571,902 to 21,571,911'),
        stage('end-done', '13 transaction hashes', '', 'First of 13, the rest are under Items', {
          hash: H5,
          links: [explorer('base', H5)],
        }),
      ],
    },
  },
  {
    id: '5ac83f1e',
    label: 'Relay swap',
    mode: 'relay',
    chain: 'solana',
    status: 'failed',
    createdAt: at(1, '12:20:02'),
    when: 'Yesterday, 12:20',
    itemCount: 1,
    totals: [money('0.0814', 'SOL')],
    sender: null,
    retryPolicy: 'Not applicable',
    bulkCall: 'Not applicable',
    claimedAt: at(1, '12:20:02'),
    idempotencyKey: 'swap-4f1c9e-user-3381',
    items: makeItems({
      seed: 2,
      chain: 'solana',
      total: money('0.0814', 'SOL'),
      runs: [['failed', 1]],
      failures: {
        0: {
          code: 'CHAIN_REJECTED',
          message: 'Expired: the blockhash is past its last valid height.',
        },
      },
    }),
    flow: {
      summary: 'Failed at stage 3 of 4',
      elapsed: 'Ended at 12:21:33',
      stages: [
        stage('done', 'Received', '12:20:02', 'A signed v0 transaction, every signature verified'),
        stage(
          'done',
          'Broadcast',
          '12:20:03',
          'Resent the same bytes 11 times while the blockhash was valid',
        ),
        stage(
          'failed',
          'Expired',
          '12:21:33',
          'The blockhash is past its last valid height. The engine has no key to re-sign a Relay Dispatch.',
        ),
        stage(
          'end-failed',
          'No transaction landed',
          '',
          'Ask the wallet that signed it for a fresh transaction.',
        ),
      ],
    },
  },
  {
    id: 'd7730c45',
    label: 'Refund batch',
    mode: 'managed',
    chain: 'base',
    status: 'cancelled',
    createdAt: at(1, '10:04:51'),
    when: 'Yesterday, 10:04',
    itemCount: 9,
    totals: [money('1120.00', 'USDC')],
    sender: { name: 'payouts', address: SENDER_BASE },
    retryPolicy: 'Off',
    bulkCall: 'Yes, through the aggregator',
    claimedAt: null,
    idempotencyKey: 'refunds-2026-10-30-am',
    items: makeItems({
      seed: 9,
      chain: 'base',
      total: money('1120.00', 'USDC'),
      runs: [['cancelled', 9]],
    }),
    flow: {
      summary: 'Cancelled before it was claimed',
      elapsed: 'Ended at 10:06:10',
      stages: [
        stage('done', 'Submitted', '10:04:51', '9 payments through the API'),
        stage(
          'end-cancelled',
          'Cancelled',
          '10:06:10',
          'Withdrawn by an operator. Nothing was signed or sent.',
        ),
      ],
    },
  },
];

export function totalText(dispatch: GalleryDispatch): string {
  const total = dispatch.totals[0]!;
  return `${formatAmount(total)} ${total.asset}`;
}

export { money };
