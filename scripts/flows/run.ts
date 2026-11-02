/**
 * Runs the flows against an engine and photographs each Dispatch in the console.
 *
 *   tsx scripts/flows/run.ts            # every row
 *   tsx scripts/flows/run.ts 6 9        # only rows 6 and 9
 *
 * The engine comes from FLOWS_ENGINE_URL, FLOWS_AUTH_TOKEN, FLOWS_OPERATOR_TOKEN
 * (and FLOWS_PROXY_URL if its RPCs go through rpc-proxy.ts), or from the
 * `engine.json` that local-engine.ts writes. Results go to <state>/results-<runId>.json
 * and screenshots to <state>/shots/<row>-<label>-<view>.png.
 */
import { appendFileSync, existsSync } from 'node:fs';

import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { createPublicClient, formatEther, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  ASSETS_FILE,
  type Assets,
  BASE_RPC_URL,
  baseAddress,
  baseRunKey,
  readJson,
  senderKeys,
  SOLANA_RPC_URL,
  solanaRunKeypair,
  statePath,
  writeJson,
} from './config.js';
import { openCamera } from './console-shots.js';
import { type EngineTarget, engineApi } from './engine-api.js';
import { type FlowContext, FLOWS, type Page, type Shot, Skip, type Wallets } from './flows.js';

type RowResult = {
  row: string;
  title: string;
  outcome: 'ran' | 'skipped' | 'failed';
  reason?: string;
  dispatches: { label: string; dispatchId: string; status: string; shots: string[] }[];
  pages: string[];
  notes: string[];
};

function engineTarget(): EngineTarget & { proxyUrl: string | null } {
  if (process.env.FLOWS_ENGINE_URL) {
    return {
      url: process.env.FLOWS_ENGINE_URL,
      authToken: process.env.FLOWS_AUTH_TOKEN ?? '',
      operatorToken: process.env.FLOWS_OPERATOR_TOKEN ?? '',
      proxyUrl: process.env.FLOWS_PROXY_URL ?? null,
    };
  }
  const file = statePath('engine.json');
  if (!existsSync(file))
    throw new Error('set FLOWS_ENGINE_URL and the tokens, or run local-engine.ts up');
  return readJson(file);
}

async function balances(wallets: Wallets) {
  const solana = new Connection(SOLANA_RPC_URL, 'confirmed');
  const base = createPublicClient({ transport: http(BASE_RPC_URL) });
  const sol = async (address: string) =>
    (await solana.getBalance(new PublicKey(address))) / LAMPORTS_PER_SOL;
  const eth = async (address: `0x${string}`) => formatEther(await base.getBalance({ address }));
  return {
    at: new Date().toISOString(),
    solana: {
      payouts: await sol(wallets.solana.payouts),
      refunds: await sol(wallets.solana.refunds),
      relay: await sol(wallets.solana.relay.publicKey.toBase58()),
    },
    base: {
      payouts: await eth(wallets.base.payouts),
      refunds: await eth(wallets.base.refunds),
      relay: await eth(privateKeyToAccount(wallets.base.relayKey).address),
    },
  };
}

const target = engineTarget();
const liveLog = process.env.FLOWS_LIVE_LOG;
const paceMs = Number(process.env.FLOWS_PACE_MS ?? 0);
const live = (line: string) => {
  if (liveLog) appendFileSync(liveLog, `${new Date().toISOString()} ${line}\n`);
};
const api = engineApi(target, (key, dispatchId) => live(`submitted ${key} ${dispatchId}`));
const assets = readJson<Assets>(ASSETS_FILE);
const keys = senderKeys();
const wallets: Wallets = {
  solana: {
    payouts: keys.solana.payouts.publicKey.toBase58(),
    refunds: keys.solana.refunds.publicKey.toBase58(),
    relay: solanaRunKeypair('relay'),
  },
  base: {
    payouts: baseAddress(keys.base.payouts),
    refunds: baseAddress(keys.base.refunds),
    relayKey: baseRunKey('relay'),
  },
};
const runId = new Date()
  .toISOString()
  .replace(/[-:.TZ]/g, '')
  .slice(0, 14);
const shotsDir = statePath('shots');
const camera = await openCamera(target.url, target.operatorToken, shotsDir);
let currentRow = '';
const ctx: FlowContext = {
  api,
  assets,
  wallets,
  proxyUrl: target.proxyUrl,
  staleBlockhash: await new Connection(SOLANA_RPC_URL, 'confirmed').getLatestBlockhash('confirmed'),
  key: (label) => `flows-${runId}-${label}`,
  paceMs,
  shoot: (name, path) => camera.shoot(path, `${currentRow}-${name}`),
};

const selected = process.argv.slice(2);
const flows = FLOWS.filter((flow) => selected.length === 0 || selected.includes(flow.row));
const results: RowResult[] = [];
const report = { runId, engine: target.url, before: await balances(wallets), after: {}, results };

for (const flow of flows) {
  console.log(`row ${flow.row}: ${flow.title}`);
  currentRow = flow.row;
  live(`row ${flow.row}: ${flow.title}`);
  const result: RowResult = {
    row: flow.row,
    title: flow.title,
    outcome: 'ran',
    dispatches: [],
    pages: [],
    notes: [],
  };
  let shots: Shot[] = [];
  let pages: Page[] = [];
  try {
    const outcome = await flow.run(ctx);
    shots = outcome.dispatches;
    pages = outcome.pages ?? [];
    result.notes = outcome.notes;
  } catch (cause) {
    result.outcome = cause instanceof Skip ? 'skipped' : 'failed';
    result.reason = cause instanceof Error ? cause.message : String(cause);
  }
  for (const shot of shots) {
    const files: string[] = [];
    for (const view of ['flow', 'items', 'details'] as const) {
      const query = `dispatch=${shot.dispatchId}${view === 'flow' ? '' : `&tab=${view}`}`;
      files.push(
        await camera.shoot(`/console/dispatches?${query}`, `${flow.row}-${shot.label}-${view}`),
      );
    }
    result.dispatches.push({
      label: shot.label,
      dispatchId: shot.dispatchId,
      status: shot.view.status,
      shots: files,
    });
  }
  for (const page of pages)
    result.pages.push(await camera.shoot(page.path, `${flow.row}-${page.name}`));
  results.push(result);
  console.log(`  ${result.outcome}${result.reason ? `: ${result.reason}` : ''}`);
  for (const note of result.notes) console.log(`  ${note}`);
  writeJson(statePath(`results-${runId}.json`), report);
  await new Promise((resolve) => setTimeout(resolve, paceMs));
}

camera.close();
report.after = await balances(wallets);
writeJson(statePath(`results-${runId}.json`), report);
console.log(`results: ${statePath(`results-${runId}.json`)}`);
