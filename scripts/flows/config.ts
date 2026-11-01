import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Keypair } from '@solana/web3.js';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Everything the run creates or remembers lives here: keys, deployed assets, engine config, logs, screenshots. */
export const STATE_DIR = path.resolve(
  process.env.FLOWS_STATE_DIR ?? path.join(REPO_ROOT, 'scripts/flows/.state'),
);
mkdirSync(STATE_DIR, { recursive: true });

export const statePath = (...parts: string[]) => path.join(STATE_DIR, ...parts);

/** The repo's gitignored `.env`, read for RPC URLs only. Values are never printed. */
function readDotEnv(): Record<string, string> {
  const file = process.env.FLOWS_DOTENV ?? path.join(REPO_ROOT, '.env');
  if (!existsSync(file)) return {};
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_][A-Z0-9_]*=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  );
}
const dotEnv = readDotEnv();
const setting = (name: string, fallback: string) => process.env[name] ?? dotEnv[name] ?? fallback;

export const SOLANA_RPC_URL = setting('SOLANA_DEVNET_RPC_URL', 'https://api.devnet.solana.com');
export const BASE_RPC_URL = setting('BASE_SEPOLIA_RPC_URL', 'https://sepolia.base.org');
export const BASE_CHAIN_ID = 84532;

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** The funded devnet wallet the live tests already use (`.devnet-fixtures/sender-keypair.json`). */
export function solanaPayoutsKeypair(): Keypair {
  const file =
    process.env.FLOWS_SOLANA_KEYPAIR ??
    path.join(REPO_ROOT, '.devnet-fixtures/sender-keypair.json');
  return Keypair.fromSecretKey(Uint8Array.from(readJson<number[]>(file)));
}

/** The committed Base dev key (`signer/keys.dev.json`), funded on Base Sepolia. */
export function basePayoutsKey(): `0x${string}` {
  const keys = readJson<{ secp256k1: Record<string, string> }>(
    path.join(REPO_ROOT, 'signer/keys.dev.json'),
  );
  return `0x${keys.secp256k1['dev-sender']}`;
}

/** A throwaway devnet key the run makes once and keeps in the state dir. */
export function solanaRunKeypair(name: string): Keypair {
  const file = statePath('keys', `solana-${name}.json`);
  if (!existsSync(file)) writeJson(file, Array.from(Keypair.generate().secretKey));
  return Keypair.fromSecretKey(Uint8Array.from(readJson<number[]>(file)));
}

/** A throwaway Base Sepolia key the run makes once and keeps in the state dir. */
export function baseRunKey(name: string): `0x${string}` {
  const file = statePath('keys', `base-${name}.json`);
  if (!existsSync(file)) writeJson(file, { privateKey: generatePrivateKey() });
  return readJson<{ privateKey: `0x${string}` }>(file).privateKey;
}

export const baseAddress = (key: `0x${string}`) => privateKeyToAccount(key).address;

/** The Senders every flow run uses: `payouts` (funded fixture keys) and `refunds` (run keys the run funds). */
export function senderKeys() {
  return {
    solana: { payouts: solanaPayoutsKeypair(), refunds: solanaRunKeypair('refunds') },
    base: { payouts: basePayoutsKey(), refunds: baseRunKey('refunds') },
  };
}

/** What `prepare.ts` deployed or created on chain, cached so a rerun reuses it. */
export type Assets = {
  solana: { splMint: string; token2022Mint: string; decimals: number };
  base: { token: `0x${string}`; vault: `0x${string}`; aggregator: `0x${string}`; decimals: number };
};
export const ASSETS_FILE = statePath('assets.json');
