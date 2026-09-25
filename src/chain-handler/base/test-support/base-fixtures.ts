import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { privateKeyToAccount } from 'viem/accounts';

/**
 * Real Base Sepolia fixtures for BaseChainHandler's tests (ADR-0013: no
 * fake chain behavior for a Chain Handler, ever) — the Base analogue of
 * solana-chain-handler's test-support/devnet-fixtures.ts.
 */
export const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
export const BASE_SEPOLIA_CHAIN_ID = 84532;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * `reference-signer/keys.dev.json`'s checked-in `secp256k1.dev-sender` key
 * — reused here (rather than generating a fresh throwaway key, unlike
 * Solana's own devnet fixtures) so the one real address an operator was
 * asked to fund with Base Sepolia ETH is the exact same one every test in
 * this suite exercises.
 */
const KEYS_DEV_JSON_PATH = path.resolve(
  __dirname,
  '../../../../reference-signer/keys.dev.json',
);

export type DevSenderAccount = {
  address: `0x${string}`;
  privateKeyHex: string;
};

let cachedDevSender: DevSenderAccount | undefined;

/** The funded Base Sepolia Sender every base-chain-handler test runs against. */
export function getDevSenderAccount(): DevSenderAccount {
  if (cachedDevSender) return cachedDevSender;

  const keys = JSON.parse(readFileSync(KEYS_DEV_JSON_PATH, 'utf8')) as {
    secp256k1: Record<string, string>;
  };
  const privateKeyHex = keys.secp256k1['dev-sender'];
  if (!privateKeyHex) {
    throw new Error(`reference-signer/keys.dev.json has no secp256k1 "dev-sender" key`);
  }

  const account = privateKeyToAccount(`0x${privateKeyHex}`);
  cachedDevSender = { address: account.address, privateKeyHex };
  return cachedDevSender;
}
