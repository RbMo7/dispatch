/**
 * Starts a throwaway engine for the flows: a scratch database, the RPC proxy,
 * a dev Signer holding every Sender key, the API and the worker, with two
 * named Senders per chain and the prepared test tokens configured.
 *
 *   tsx scripts/flows/local-engine.ts up     # writes <state>/engine.json
 *   tsx scripts/flows/local-engine.ts down   # stops everything, drops the database
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, openSync, rmSync } from 'node:fs';
import path from 'node:path';

import postgres from 'postgres';

import { baseAddress, readJson, REPO_ROOT, senderKeys, statePath, writeJson } from './config.js';
import { prepareAssets } from './prepare.js';

const API_PORT = Number(process.env.FLOWS_API_PORT ?? 8501);
const SIGNER_PORT = Number(process.env.FLOWS_SIGNER_PORT ?? 8502);
const PROXY_PORT = Number(process.env.FLOWS_PROXY_PORT ?? 8503);
const PG_ADMIN_URL =
  process.env.FLOWS_PG_ADMIN_URL ?? 'postgres://dispatch:dispatch@localhost:5433/postgres';
const DB_NAME = process.env.FLOWS_DB_NAME ?? 'dispatch_flows_scratch';

export type EngineHandle = {
  url: string;
  authToken: string;
  operatorToken: string;
  proxyUrl: string;
  databaseUrl: string;
  pids: number[];
};
const ENGINE_FILE = statePath('engine.json');

const databaseUrl = () => {
  const url = new URL(PG_ADMIN_URL);
  url.pathname = `/${DB_NAME}`;
  return url.toString();
};

async function admin<T>(work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  if (DB_NAME === 'dispatch') throw new Error('refusing to touch the dispatch database');
  const sql = postgres(PG_ADMIN_URL, { max: 1, onnotice: () => {} });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

function writeEngineConfig() {
  const keys = senderKeys();
  const solana = {
    payouts: keys.solana.payouts.publicKey.toBase58(),
    refunds: keys.solana.refunds.publicKey.toBase58(),
  };
  const base = { payouts: baseAddress(keys.base.payouts), refunds: baseAddress(keys.base.refunds) };
  writeJson(statePath('senders.json'), {
    solana: {
      default: 'payouts',
      senders: { payouts: { address: solana.payouts }, refunds: { address: solana.refunds } },
    },
    base: {
      default: 'payouts',
      senders: { payouts: { address: base.payouts }, refunds: { address: base.refunds } },
    },
  });
  writeJson(statePath('signer-config.json'), {
    [solana.payouts]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'solana-payouts' },
    [solana.refunds]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'solana-refunds' },
    [base.payouts]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'base-payouts' },
    [base.refunds]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'base-refunds' },
  });
  const seed = (kp: { secretKey: Uint8Array }) =>
    Buffer.from(kp.secretKey.slice(0, 32)).toString('hex');
  writeJson(statePath('signer-keys.json'), {
    ed25519: {
      'solana-payouts': seed(keys.solana.payouts),
      'solana-refunds': seed(keys.solana.refunds),
    },
    secp256k1: {
      'base-payouts': keys.base.payouts.slice(2),
      'base-refunds': keys.base.refunds.slice(2),
    },
  });
}

function launch(name: string, args: string[], cwd: string, env: Record<string, string>): number {
  const log = openSync(statePath('logs', `${name}.log`), 'a');
  const child = spawn(path.join(REPO_ROOT, 'node_modules/.bin/tsx'), args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', log, log],
    detached: true,
  });
  child.unref();
  if (!child.pid) throw new Error(`${name} did not start`);
  return child.pid;
}

async function waitFor(url: string, token: string) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${url} never answered; see ${statePath('logs')}`);
}

async function up(): Promise<EngineHandle> {
  if (existsSync(ENGINE_FILE)) throw new Error(`${ENGINE_FILE} exists: run "down" first`);
  const assets = await prepareAssets();
  writeEngineConfig();
  mkdirSync(statePath('logs'), { recursive: true });

  await admin(async (sql) => {
    await sql.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await sql.unsafe(`CREATE DATABASE ${DB_NAME}`);
  });
  const migrated = spawnSync('pnpm', ['db:migrate'], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl() },
    encoding: 'utf8',
  });
  if (migrated.status !== 0) throw new Error(`migration failed:\n${migrated.stderr}`);

  const proxyUrl = `http://127.0.0.1:${PROXY_PORT}`;
  const signerToken = randomBytes(24).toString('hex');
  const handle: EngineHandle = {
    url: `http://127.0.0.1:${API_PORT}`,
    authToken: randomBytes(32).toString('hex'),
    operatorToken: randomBytes(32).toString('hex'),
    proxyUrl,
    databaseUrl: databaseUrl(),
    pids: [],
  };
  const engineEnv = {
    DATABASE_URL: handle.databaseUrl,
    AUTH_TOKEN: handle.authToken,
    ENABLED_CHAINS: 'solana,base',
    SENDERS_FILE: statePath('senders.json'),
    SOLANA_RPC_URL: `${proxyUrl}/solana`,
    BASE_RPC_URL: `${proxyUrl}/base`,
    SOLANA_KNOWN_TOKENS: `FSPL:${assets.solana.splMint}:6,F22:${assets.solana.token2022Mint}:6:token-2022`,
    BASE_KNOWN_TOKENS: `FLOW:${assets.base.token}:6`,
    BASE_STUCK_AFTER_MS: '30000',
    LOG_LEVEL: 'info',
  };

  handle.pids.push(
    launch('proxy', [path.join(REPO_ROOT, 'scripts/flows/rpc-proxy.ts')], REPO_ROOT, {
      FLOWS_PROXY_PORT: String(PROXY_PORT),
    }),
  );
  handle.pids.push(
    launch('signer', ['src/index.ts'], path.join(REPO_ROOT, 'signer'), {
      PORT: String(SIGNER_PORT),
      SIGNER_AUTH_TOKEN: signerToken,
      SIGNER_CONFIG: statePath('signer-config.json'),
      SIGNER_KEYFILE: statePath('signer-keys.json'),
    }),
  );
  handle.pids.push(
    launch('api', ['src/index.ts'], REPO_ROOT, {
      ...engineEnv,
      PORT: String(API_PORT),
      OPERATOR_TOKEN: handle.operatorToken,
    }),
  );
  handle.pids.push(
    launch('worker', ['src/worker.ts'], REPO_ROOT, {
      ...engineEnv,
      SIGNER_URL: `http://127.0.0.1:${SIGNER_PORT}`,
      SIGNER_AUTH_TOKEN: signerToken,
    }),
  );
  writeJson(ENGINE_FILE, handle);
  await waitFor(`${handle.url}/v1/token`, handle.authToken);
  return handle;
}

const signalGroup = (pid: number, signal: NodeJS.Signals | 0): boolean => {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
};

/**
 * The worker's graceful shutdown waits out its loops' sleeps (up to its own
 * 30s force-exit), so SIGTERM alone can leave it running; escalate to SIGKILL.
 */
async function stop(pids: number[]) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (const pid of pids) signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (pids.some((pid) => signalGroup(pid, 0)) && Date.now() < deadline) await sleep(200);
  for (const pid of pids) signalGroup(pid, 'SIGKILL');
  while (pids.some((pid) => signalGroup(pid, 0))) await sleep(100);
}

async function down() {
  if (existsSync(ENGINE_FILE)) {
    await stop(readJson<EngineHandle>(ENGINE_FILE).pids);
    rmSync(ENGINE_FILE);
  }
  await admin((sql) => sql.unsafe(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`));
  console.log(`stopped; dropped ${DB_NAME}`);
}

const command = process.argv[2];
if (command === 'up') {
  const handle = await up();
  console.log(`engine up at ${handle.url}; tokens in ${ENGINE_FILE}`);
} else if (command === 'down') {
  await down();
} else {
  console.error('usage: local-engine.ts up|down');
  process.exit(2);
}
