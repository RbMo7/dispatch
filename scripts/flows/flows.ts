/**
 * One entry per row of the flow-coverage table (`.scratch/flow-coverage/spec.md`)
 * that today's engine can run. Each flow submits its Dispatches, drives them
 * to an end state, and returns them for the runner to photograph.
 */
import {
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { createPublicClient, encodeFunctionData, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { type Assets, BASE_CHAIN_ID, BASE_RPC_URL, SOLANA_RPC_URL } from './config.js';
import { FLOW_VAULT_ABI } from './contracts.js';
import { type DispatchView, type EngineApi, SETTLED } from './engine-api.js';

export type Wallets = {
  solana: { payouts: string; refunds: string; relay: Keypair };
  base: { payouts: `0x${string}`; refunds: `0x${string}`; relayKey: `0x${string}` };
};

export type FlowContext = {
  api: EngineApi;
  assets: Assets;
  wallets: Wallets;
  /** The RPC proxy's control URL, when the engine's RPCs go through it; rows 9 and 10 need it. */
  proxyUrl: string | null;
  /** A blockhash captured when the run started, old enough by row 10 to have expired. */
  staleBlockhash: { blockhash: string; lastValidBlockHeight: number };
  key: (label: string) => string;
  /** Photographs a console page now, for a state the flow moves past, such as a hold. */
  shoot: (name: string, path: string) => Promise<string>;
  /** How long to leave a state on screen for someone watching the console; 0 by default. */
  paceMs: number;
};

export type Shot = { label: string; dispatchId: string; view: DispatchView };
export type Page = { name: string; path: string };
export type FlowResult = { dispatches: Shot[]; pages?: Page[]; notes: string[] };
export type Flow = { row: string; title: string; run: (ctx: FlowContext) => Promise<FlowResult> };

/** Thrown when a row cannot run against this engine; the runner records the reason. */
export class Skip extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settled = (d: DispatchView) => SETTLED.has(d.status);
const solana = new Connection(SOLANA_RPC_URL, 'confirmed');
const base = createPublicClient({ transport: http(BASE_RPC_URL) });
const WEI_SMALL = '1000000000000';

async function settle(ctx: FlowContext, label: string, body: unknown): Promise<Shot> {
  const dispatchId = await ctx.api.submit(ctx.key(label), body);
  return { label, dispatchId, view: await ctx.api.waitUntil(dispatchId, settled) };
}

function summarize(shot: Shot): string {
  const items = (shot.view.items ?? [])
    .map((i, n) => `#${n} ${i.status}${i.error ? ` ${i.error.code}` : ''}`)
    .join(', ');
  const kinds = (shot.view.timeline ?? []).map((t) => t.kind).join(' > ');
  return `${shot.label}: ${shot.view.status}${items ? ` [${items}]` : ''}${shot.view.error ? ` ${shot.view.error.code}` : ''}; timeline ${kinds}`;
}

async function arm(ctx: FlowContext, trap: Record<string, unknown>) {
  if (!ctx.proxyUrl) throw new Skip('the engine RPCs do not go through the flows proxy');
  const res = await fetch(`${ctx.proxyUrl}/__flows/arm`, {
    method: 'POST',
    body: JSON.stringify(trap),
  });
  if (res.status !== 204)
    throw new Error(`proxy refused ${JSON.stringify(trap)}: ${await res.text()}`);
}

async function proxyLog(ctx: FlowContext): Promise<string[]> {
  if (!ctx.proxyUrl) return [];
  const log = (await (await fetch(`${ctx.proxyUrl}/__flows/log`)).json()) as {
    trap: string;
    detail: string;
  }[];
  return log.map((l) => `proxy ${l.trap}: ${l.detail}`);
}

export const FLOWS: Flow[] = [
  {
    row: '14',
    title:
      'Named Senders, part 1: the default Sender funds the second Sender and the relay wallets',
    async run(ctx) {
      const sol = await settle(ctx, 'payouts-sol', {
        chain: 'solana',
        items: [
          {
            type: 'payment',
            recipient: ctx.wallets.solana.refunds,
            asset: 'SOL',
            amount: '10000000',
          },
          {
            type: 'payment',
            recipient: ctx.wallets.solana.relay.publicKey.toBase58(),
            asset: 'SOL',
            amount: '3000000',
          },
        ],
      });
      const eth = await settle(ctx, 'payouts-base', {
        chain: 'base',
        items: [
          {
            type: 'payment',
            recipient: ctx.wallets.base.refunds,
            asset: 'ETH',
            amount: '50000000000000',
          },
          {
            type: 'payment',
            recipient: privateKeyToAccount(ctx.wallets.base.relayKey).address,
            asset: 'ETH',
            amount: '20000000000000',
          },
        ],
      });
      return { dispatches: [sol, eth], notes: [summarize(sol), summarize(eth)] };
    },
  },
  {
    row: '1',
    title: 'Payments in a configured SPL token and a Token-2022 token',
    async run(ctx) {
      const shot = await settle(ctx, 'spl-and-2022', {
        chain: 'solana',
        items: [
          {
            type: 'payment',
            recipient: ctx.wallets.solana.refunds,
            asset: 'FSPL',
            amount: '1500000',
          },
          {
            type: 'payment',
            recipient: ctx.wallets.solana.refunds,
            asset: 'F22',
            amount: '2500000',
          },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot)] };
    },
  },
  {
    row: '2',
    title: 'Payment in an ERC-20 (a test token the run deployed)',
    async run(ctx) {
      const shot = await settle(ctx, 'erc20', {
        chain: 'base',
        items: [
          {
            type: 'payment',
            recipient: ctx.wallets.base.refunds,
            asset: 'FLOW',
            amount: '1500000',
          },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot)] };
    },
  },
  {
    row: '3',
    title: 'Payment in an unconfigured asset (baseline for the Rejected page)',
    async run(ctx) {
      const before = await ctx.api.call('GET', '/v1/dispatches?limit=100');
      const reply = await ctx.api.call('POST', '/v1/dispatch', {
        key: ctx.key('unknown-asset'),
        body: {
          chain: 'base',
          items: [
            {
              type: 'payment',
              recipient: ctx.wallets.base.refunds,
              asset: 'USDT',
              amount: '1000000',
            },
          ],
        },
      });
      const after = await ctx.api.call('GET', '/v1/dispatches?limit=100');
      const activity = await ctx.api.call('GET', '/v1/activity', { operator: true });
      const count = (r: typeof before) => (r.body.dispatches as unknown[]).length;
      const mentions = JSON.stringify(activity.body).includes('USDT');
      return {
        dispatches: [],
        pages: [
          { name: 'dispatches', path: '/console/dispatches' },
          { name: 'overview', path: '/console' },
          { name: 'activity', path: '/console/activity' },
        ],
        notes: [
          `POST answered ${reply.status} ${JSON.stringify(reply.body)}`,
          `dispatches listed before ${count(before)}, after ${count(after)}`,
          `activity record mentions USDT: ${mentions}`,
        ],
      };
    },
  },
  {
    row: '4',
    title: 'A Base call with value to a test contract the run deployed',
    async run(ctx) {
      const shot = await settle(ctx, 'call-value', {
        chain: 'base',
        items: [
          {
            type: 'call',
            to: ctx.assets.base.vault,
            data: encodeFunctionData({
              abi: FLOW_VAULT_ABI,
              functionName: 'deposit',
              args: ['flows row 4'],
            }),
            value: WEI_SMALL,
          },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot)] };
    },
  },
  {
    row: '5',
    title: 'A Solana program call: Memo plus a raw SPL transfer',
    async run(ctx) {
      const mint = new PublicKey(ctx.assets.solana.splMint);
      const owner = new PublicKey(ctx.wallets.solana.payouts);
      const ix = createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, owner),
        mint,
        getAssociatedTokenAddressSync(mint, new PublicKey(ctx.wallets.solana.refunds)),
        owner,
        250_000n,
        ctx.assets.solana.decimals,
        [],
        TOKEN_PROGRAM_ID,
      );
      const shot = await settle(ctx, 'memo-and-spl', {
        chain: 'solana',
        items: [
          {
            type: 'call',
            programId: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
            accounts: [],
            data: Buffer.from('flows row 5').toString('base64'),
          },
          {
            type: 'call',
            programId: ix.programId.toBase58(),
            accounts: ix.keys.map((k) => ({
              pubkey: k.pubkey.toBase58(),
              isSigner: k.isSigner,
              isWritable: k.isWritable,
            })),
            data: ix.data.toString('base64'),
          },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot)] };
    },
  },
  {
    row: '6',
    title: 'Relay on both chains: transactions signed outside the engine',
    async run(ctx) {
      const relay = ctx.wallets.solana.relay;
      const { blockhash, lastValidBlockHeight } = await solana.getLatestBlockhash('confirmed');
      const solTx = new Transaction({
        feePayer: relay.publicKey,
        blockhash,
        lastValidBlockHeight,
      }).add(
        SystemProgram.transfer({
          fromPubkey: relay.publicKey,
          toPubkey: new PublicKey(ctx.wallets.solana.payouts),
          lamports: 1_000_000,
        }),
      );
      solTx.sign(relay);
      const solShot = await settle(ctx, 'relay-solana', {
        chain: 'solana',
        mode: 'relay',
        signedTransaction: solTx.serialize().toString('base64'),
      });

      const account = privateKeyToAccount(ctx.wallets.base.relayKey);
      const block = await base.getBlock();
      const signed = await account.signTransaction({
        chainId: BASE_CHAIN_ID,
        type: 'eip1559',
        to: ctx.wallets.base.payouts,
        value: BigInt(WEI_SMALL),
        nonce: await base.getTransactionCount({ address: account.address, blockTag: 'pending' }),
        gas: 21_000n,
        maxFeePerGas: block.baseFeePerGas! * 2n + 1_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      });
      const baseShot = await settle(ctx, 'relay-base', {
        chain: 'base',
        mode: 'relay',
        signedTransaction: signed,
      });
      return { dispatches: [solShot, baseShot], notes: [summarize(solShot), summarize(baseShot)] };
    },
  },
  {
    row: '7',
    title: 'Bulk Call with allowFailure false, through an aggregator the run deployed',
    async run(ctx) {
      const shot = await settle(ctx, 'bulk-call', {
        chain: 'base',
        bulkCall: { aggregator: ctx.assets.base.aggregator, maxBatchSize: 10 },
        items: [
          { type: 'payment', recipient: ctx.wallets.base.refunds, asset: 'FLOW', amount: '500000' },
          { type: 'payment', recipient: ctx.wallets.base.refunds, asset: 'ETH', amount: WEI_SMALL },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot)] };
    },
  },
  {
    row: '8',
    title: 'Partial: one payment lands, one call reverts',
    async run(ctx) {
      const shot = await settle(ctx, 'partial', {
        chain: 'base',
        items: [
          { type: 'payment', recipient: ctx.wallets.base.refunds, asset: 'ETH', amount: WEI_SMALL },
          {
            type: 'call',
            to: ctx.assets.base.vault,
            data: encodeFunctionData({ abi: FLOW_VAULT_ABI, functionName: 'revertAlways' }),
            value: '0',
          },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot)] };
    },
  },
  {
    row: '9',
    title: 'Fee bump: Retry Policy on, a deliberately low starting fee',
    async run(ctx) {
      await arm(ctx, { trap: 'underpriced', ms: 20_000 });
      const shot = await settle(ctx, 'fee-bump', {
        chain: 'base',
        retryPolicy: true,
        items: [
          { type: 'payment', recipient: ctx.wallets.base.refunds, asset: 'ETH', amount: WEI_SMALL },
        ],
      });
      const bumped = (shot.view.timeline ?? []).some((t) => t.replaces);
      return {
        dispatches: [shot],
        notes: [
          summarize(shot),
          `a replacement transaction is in the timeline: ${bumped}`,
          ...(await proxyLog(ctx)),
        ],
      };
    },
  },
  {
    row: '13',
    title: 'Held, released and cancelled',
    async run(ctx) {
      const rule = await ctx.api.call('POST', '/v1/flag-rules', {
        operator: true,
        body: {
          name: 'Flows: SOL over 0.0015',
          chain: 'solana',
          kind: 'item_over',
          asset: 'SOL',
          limit: '0.0015',
          sender: 'payouts',
          reason: 'flow-coverage run, row 13',
        },
      });
      if (rule.status !== 201)
        throw new Error(`flag rule: ${rule.status} ${JSON.stringify(rule.body)}`);
      const held = async (label: string) => {
        const id = await ctx.api.submit(ctx.key(label), {
          chain: 'solana',
          items: [
            {
              type: 'payment',
              recipient: ctx.wallets.solana.refunds,
              asset: 'SOL',
              amount: '2000000',
            },
          ],
        });
        await ctx.api.waitUntil(id, (d) => d.status === 'held', 30_000);
        return id;
      };
      const releasedId = await held('released');
      const cancelledId = await held('cancelled');
      await sleep(ctx.paceMs);
      const heldShots = [
        await ctx.shoot('held-page', '/console/held'),
        await ctx.shoot('held-flow', `/console/dispatches?dispatch=${releasedId}`),
        await ctx.shoot('held-details', `/console/dispatches?dispatch=${releasedId}&tab=details`),
      ];
      const release = await ctx.api.call('POST', `/v1/dispatch/${releasedId}/release`, {
        operator: true,
        body: { reason: 'flow-coverage run: checked and fine' },
      });
      const cancel = await ctx.api.call('POST', `/v1/dispatch/${cancelledId}/cancel`, {
        body: { reason: 'flow-coverage run: not wanted' },
      });
      const disable = await ctx.api.call('PUT', `/v1/flag-rules/${rule.body.ruleId as string}`, {
        operator: true,
        body: {
          name: 'Flows: SOL over 0.0015',
          chain: 'solana',
          kind: 'item_over',
          asset: 'SOL',
          limit: '0.0015',
          sender: 'payouts',
          enabled: false,
          reason: 'flow-coverage run finished with it',
        },
      });
      const released: Shot = {
        label: 'released',
        dispatchId: releasedId,
        view: await ctx.api.waitUntil(releasedId, settled),
      };
      const cancelled: Shot = {
        label: 'cancelled',
        dispatchId: cancelledId,
        view: await ctx.api.getDispatch(cancelledId),
      };
      return {
        dispatches: [released, cancelled],
        pages: [{ name: 'activity', path: '/console/activity' }],
        notes: [
          `while held: ${heldShots.join(', ')}`,
          `release ${release.status}, cancel ${cancel.status}, rule disabled ${disable.status}`,
          summarize(released),
          summarize(cancelled),
        ],
      };
    },
  },
  {
    row: '14',
    title: 'Named Senders, part 2: the second Sender pays on each chain',
    async run(ctx) {
      const sol = await settle(ctx, 'refunds-sol', {
        chain: 'solana',
        sender: 'refunds',
        items: [
          {
            type: 'payment',
            recipient: ctx.wallets.solana.payouts,
            asset: 'SOL',
            amount: '1000000',
          },
        ],
      });
      const eth = await settle(ctx, 'refunds-base', {
        chain: 'base',
        sender: 'refunds',
        items: [
          { type: 'payment', recipient: ctx.wallets.base.payouts, asset: 'ETH', amount: WEI_SMALL },
        ],
      });
      return {
        dispatches: [sol, eth],
        pages: [
          { name: 'senders', path: '/console/senders' },
          { name: 'dispatches-refunds', path: '/console/dispatches?sender=refunds' },
        ],
        notes: [summarize(sol), summarize(eth)],
      };
    },
  },
  {
    row: '10',
    title: 'Solana expiry and resend: the engine signs over a stale blockhash',
    async run(ctx) {
      const needed = ctx.staleBlockhash.lastValidBlockHeight + 150 + 10;
      while ((await solana.getBlockHeight('confirmed')) <= needed) {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      await arm(ctx, { trap: 'staleBlockhash', ...ctx.staleBlockhash });
      const shot = await settle(ctx, 'expiry', {
        chain: 'solana',
        items: [
          {
            type: 'payment',
            recipient: ctx.wallets.solana.refunds,
            asset: 'SOL',
            amount: '1000000',
          },
        ],
      });
      return { dispatches: [shot], notes: [summarize(shot), ...(await proxyLog(ctx))] };
    },
  },
];
