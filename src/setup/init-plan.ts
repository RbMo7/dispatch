import { isAddress } from 'viem';

import { parsePublicKey } from '../chain-handler/solana/multisig/multisig-config.js';
import { configFrom, type Env } from '../config.js';
import type { Chain } from '../domain/chain.js';
import { DEV_AUTH_TOKEN, MIN_TOKEN_LENGTH } from './checks/configuration.js';
import type { SenderName } from '../domain/sender.js';
import { senderLabel, type Settings } from './settings.js';

export type Network = 'test' | 'main';
export type Backend = 'local' | 'privy' | 'aws-kms' | 'keyfile';
export type Curve = 'ed25519' | 'secp256k1';

/** How a Sender's key is held. A new `local` key gets its address from the Signer's `keys new`. */
export type Signing =
  | { backend: 'local' }
  | { backend: 'privy' | 'aws-kms'; keyRef: string; address: string }
  | { backend: 'keyfile' };

export type SenderShape =
  { kind: 'plain' } | { kind: 'squads'; multisig: string } | { kind: 'safe'; safe: string };

/**
 * One Sender as the operator set it up in this run. `name` is the Sender's
 * name in the senders file (ADR-0060); undefined for the one Sender today's
 * variables describe.
 */
export type ChainChoice = {
  chain: Chain;
  network: Network;
  rpcUrl: string;
  name?: SenderName;
  signing: Signing;
  sender: SenderShape;
};

export type Database = { kind: 'compose' } | { kind: 'url'; url: string };

/** A key the Signer holds, once known: a new local key after `keys new`, any other as given. */
export type HeldKey = { address: string; backend: Backend; keyRef: string };

export const CURVE: Record<Chain, Curve> = { solana: 'ed25519', base: 'secp256k1' };

export const NETWORK_NAMES: Record<Chain, Record<Network, string>> = {
  solana: { test: 'devnet', main: 'mainnet' },
  base: { test: 'Base Sepolia', main: 'Base mainnet' },
};

export const DEFAULT_RPC: Record<Chain, Record<Network, string>> = {
  solana: { test: 'https://api.devnet.solana.com', main: 'https://api.mainnet-beta.solana.com' },
  base: { test: 'https://sepolia.base.org', main: 'https://mainnet.base.org' },
};

const BASE_CHAIN_ID: Record<Network, number> = { test: 84532, main: 8453 };

/** The committed dev keys (`signer/keys.dev.json`), which the `keyfile` backend signs with. */
export const DEV_KEYS: Record<Chain, HeldKey> = {
  solana: {
    address: '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe',
    backend: 'keyfile',
    keyRef: 'dev-sender',
  },
  base: {
    address: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
    backend: 'keyfile',
    keyRef: 'dev-sender',
  },
};

export const FAUCETS: Record<Chain, string> = {
  solana: 'https://faucet.solana.com',
  base: 'https://docs.base.org/base-chain/tools/network-faucets',
};

export const COMPOSE_DATABASE_URL = 'postgres://dispatch:dispatch@localhost:5432/dispatch';
/** Where Compose's signer container sees `signer/local/`. */
export const CONTAINER_SIGNER_CONFIG = '/app/local/signer.config.json';
const DEV_SIGNER_TOKEN = 'dev-only-signer-token';

export function isChainAddress(chain: Chain, value: string): boolean {
  return chain === 'solana' ? parsePublicKey(value) !== undefined : isAddress(value);
}

export function sameAddress(a: string, b: string): boolean {
  return a === b || (a.startsWith('0x') && a.toLowerCase() === b.toLowerCase());
}

/** The engine variables one chain's choice sets. An empty value clears what another Sender shape left behind. */
export function chainEnv(choice: ChainChoice, key: HeldKey): Record<string, string> {
  const { sender } = choice;
  if (choice.chain === 'solana') {
    const squads = sender.kind === 'squads';
    return {
      SOLANA_RPC_URL: choice.rpcUrl,
      SOLANA_SENDER_MODE: squads ? 'multisig' : 'single',
      SOLANA_SENDER_ADDRESS: squads ? '' : key.address,
      SOLANA_MULTISIG_ADDRESS: squads ? sender.multisig : '',
      SOLANA_MULTISIG_MEMBER_ADDRESS: squads ? key.address : '',
    };
  }
  const safe = sender.kind === 'safe';
  return {
    BASE_RPC_URL: choice.rpcUrl,
    BASE_CHAIN_ID: String(BASE_CHAIN_ID[choice.network]),
    BASE_SENDER_MODE: safe ? 'safe' : 'single',
    BASE_SENDER_ADDRESS: safe ? '' : key.address,
    BASE_SAFE_ADDRESS: safe ? sender.safe : '',
    BASE_SAFE_EXECUTOR_ADDRESS: safe ? key.address : '',
  };
}

/** With a senders file the engine ignores a chain's Sender variables, so init clears them rather than leave a second, stale description. */
export function clearedSenderVariables(chain: Chain): Record<string, string> {
  const names =
    chain === 'solana'
      ? [
          'SOLANA_SENDER_MODE',
          'SOLANA_SENDER_ADDRESS',
          'SOLANA_MULTISIG_ADDRESS',
          'SOLANA_MULTISIG_MEMBER_ADDRESS',
        ]
      : [
          'BASE_SENDER_MODE',
          'BASE_SENDER_ADDRESS',
          'BASE_SAFE_ADDRESS',
          'BASE_SAFE_EXECUTOR_ADDRESS',
        ];
  return Object.fromEntries(names.map((name) => [name, '']));
}

export function databaseEnv(database: Database): Record<string, string> {
  return database.kind === 'compose'
    ? { DATABASE_URL: COMPOSE_DATABASE_URL, CONTAINER_DATABASE_URL: '' }
    : { DATABASE_URL: database.url, CONTAINER_DATABASE_URL: database.url };
}

/** Tokens that would fail doctor's token check get a fresh random value; a good one is kept, so a re-run never rotates it. */
export function tokenEnv(current: Env, random: () => string): Record<string, string> {
  const updates: Record<string, string> = {};
  const weak = (value: string | undefined, ...defaults: string[]) =>
    value === undefined || value.length < MIN_TOKEN_LENGTH || defaults.includes(value);
  const auth = weak(current.AUTH_TOKEN, DEV_AUTH_TOKEN) ? random() : current.AUTH_TOKEN!;
  if (auth !== current.AUTH_TOKEN) updates.AUTH_TOKEN = auth;
  if (weak(current.OPERATOR_TOKEN, auth)) updates.OPERATOR_TOKEN = random();
  if (weak(current.SIGNER_AUTH_TOKEN, DEV_SIGNER_TOKEN)) updates.SIGNER_AUTH_TOKEN = random();
  return updates;
}

export type SignerEntry = {
  curve: Curve;
  backend: Backend;
  keyRef: string;
  policy?: Record<string, unknown>;
};

const PINS = ['chainIds', 'allowedSafe', 'allowedMultiSend', 'allowedMultisig'] as const;

/** The pins a key needs: the chain id on Base, and its multisig or Safe for a Multisig Sender (ADR-0055). */
function pins(choice: ChainChoice): Record<string, unknown> {
  const { sender } = choice;
  if (choice.chain === 'solana') {
    return sender.kind === 'squads' ? { allowedMultisig: sender.multisig } : {};
  }
  const chainIds = [BASE_CHAIN_ID[choice.network]];
  return sender.kind === 'safe' ? { chainIds, allowedSafe: sender.safe } : { chainIds };
}

/**
 * The Signer config with each changed chain's key in it. An entry already
 * there for the same address keeps the rules the operator added, with its
 * pins replaced. A key a changed chain no longer uses is dropped, unless
 * another chain still uses it, so a backend nobody needs is never built.
 */
export function updateSignerConfig(
  current: Readonly<Record<string, unknown>>,
  changes: readonly { choice: ChainChoice; key: HeldKey; replaces?: string }[],
  inUse: readonly string[],
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  const find = (address: string) => Object.keys(next).find((key) => sameAddress(key, address));

  for (const { key, replaces } of changes) {
    if (replaces === undefined || sameAddress(replaces, key.address)) continue;
    if (inUse.some((address) => sameAddress(address, replaces))) continue;
    const stale = find(replaces);
    if (stale !== undefined) delete next[stale];
  }
  for (const { choice, key } of changes) {
    const existingKey = find(key.address);
    const existing = existingKey === undefined ? undefined : next[existingKey];
    const policy: Record<string, unknown> = { ...policyOf(existing) };
    for (const pin of PINS) {
      if (pin !== 'allowedMultiSend' || choice.sender.kind !== 'safe') delete policy[pin];
    }
    Object.assign(policy, pins(choice));
    if (existingKey !== undefined) delete next[existingKey];
    next[key.address] = {
      curve: CURVE[choice.chain],
      backend: key.backend,
      keyRef: key.keyRef,
      policy,
    } satisfies SignerEntry;
  }
  return next;
}

function policyOf(entry: unknown): Record<string, unknown> {
  if (typeof entry !== 'object' || entry === null) return {};
  const policy = (entry as { policy?: unknown }).policy;
  return typeof policy === 'object' && policy !== null ? (policy as Record<string, unknown>) : {};
}

export function backendsIn(config: Readonly<Record<string, unknown>>): Set<string> {
  return new Set(
    Object.values(config).flatMap((entry) => {
      const backend = (entry as { backend?: unknown } | null)?.backend;
      return typeof backend === 'string' ? [backend] : [];
    }),
  );
}

/** What test network or mainnet the engine's settings point a chain at; undefined for a Solana RPC whose URL doesn't say. */
export function networkOf(chain: Chain, env: Env): Network | undefined {
  const config = configFrom(env);
  if (chain === 'base') return config.base.chainId === BASE_CHAIN_ID.main ? 'main' : 'test';
  const url = config.solana.rpcUrl.toLowerCase();
  if (url.includes('devnet')) return 'test';
  if (url.includes('mainnet')) return 'main';
  return undefined;
}

export type Funding = {
  /** The Sender it belongs to: "Solana", or "refunds on Solana" for a named one. */
  label: string;
  chain: Chain;
  address: string;
  pays: string;
  network: Network | undefined;
};

/** Each address to fund, read back from the settings as the engine parses them. */
export function addressesToFund(env: Env, settings: Settings): Funding[] {
  return settings.senders.flatMap(({ chain, name, accounts, multisig }) => {
    if (!accounts) return [];
    const network = networkOf(chain, env);
    const symbol = accounts.native.symbol;
    const label = senderLabel({ chain, name });
    if (!multisig) {
      return [
        { label, address: accounts.address, pays: `payments and fees (${symbol})`, chain, network },
      ];
    }
    const holder = multisig.kind === 'squads' ? 'Squads vault' : 'Safe';
    return [
      { label, address: accounts.address, pays: `payments, from the ${holder}`, chain, network },
      {
        label,
        address: accounts.feePayer,
        pays: `the engine key's fees (${symbol})`,
        chain,
        network,
      },
    ];
  });
}

/** One line per configured Sender, for the "current setup" summary on a re-run. */
export function describeChains(
  env: Env,
  settings: Settings,
  signerConfig: Readonly<Record<string, unknown>>,
): string[] {
  return settings.senders.flatMap(({ chain, name, accounts, multisig, isDefault }) => {
    if (!accounts) return [];
    const network = networkOf(chain, env);
    const where = network ? NETWORK_NAMES[chain][network] : 'a custom RPC';
    const shape =
      multisig?.kind === 'squads'
        ? `Squads vault ${accounts.address}, engine key ${accounts.feePayer}`
        : multisig?.kind === 'safe'
          ? `Safe ${accounts.address}, executor ${accounts.feePayer}`
          : `plain Sender ${accounts.address}`;
    const entryKey = Object.keys(signerConfig).find((key) => sameAddress(key, accounts.feePayer));
    const entry = entryKey === undefined ? undefined : (signerConfig[entryKey] as SignerEntry);
    const held = entry ? `${entry.backend} key ${entry.keyRef}` : 'no key in the Signer config';
    const marked = name !== null && isDefault ? ' (default)' : '';
    return [`${senderLabel({ chain, name })}${marked}: ${where}, ${shape}, ${held}`];
  });
}
