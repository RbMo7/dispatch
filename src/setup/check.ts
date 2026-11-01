import type { Config, Env } from '../config.js';
import type { Chain } from '../domain/chain.js';
import type { Balance } from '../chain-handler/chain-handler.js';
import type { DispatchError } from '../domain/errors.js';
import type { KnownAsset } from '../domain/known-asset.js';
import type { ForeignActivity } from '../domain/sender.js';
import type { Result } from '../domain/result.js';
import type { PolicyRead } from '../signer/client.js';
import type { SenderSetup, Settings } from './settings.js';

export const AREAS = [
  'configuration',
  'database',
  'chain',
  'signer',
  'sender',
  'multisig',
  'console',
] as const;
export type Area = (typeof AREAS)[number];

/**
 * `cli` is `doctor` (and later `init`); `worker` is the worker's periodic run,
 * recorded for the console; `api` is the API process, on each `GET /v1/setup`,
 * for the checks that need no Signer and no chain (ADR-0059).
 */
export type Place = 'cli' | 'worker' | 'api';

/** What to do about a warning or a failure. A `step` is done outside this machine, such as funding an address or adding a multisig member. */
export type Fix = { command: string } | { setting: string; value: string } | { step: string };

export type CheckResult =
  { status: 'pass'; finding: string } | { status: 'warn' | 'fail'; finding: string; fix: Fix };

/** The network an RPC says it serves. */
export type NetworkRead =
  { chain: 'solana'; genesisHash: string } | { chain: 'base'; chainId: number };

/** What a check may read from one enabled chain. Every read throws or returns an error when the RPC fails. */
export type ChainReads = {
  network: () => Promise<NetworkRead>;
  balance: (address: string, asset: string) => Promise<Result<Balance, DispatchError>>;
  /** The enabled tokens the Known Asset registry holds on this chain once the engine has seeded it (ADR-0061). */
  tokens: () => Promise<{ symbol: string; decimals: number }[]>;
  /** The fee a landed transaction paid, in the chain's smallest unit; undefined when it never landed. */
  feePaid: (hash: string) => Promise<bigint | undefined>;
};

/** A Multisig Sender's startup checks (ADR-0049, ADR-0051, ADR-0055), run as the worker runs them, but collected instead of thrown. */
export type MultisigStartup = {
  failures: { check: string; message: string }[];
  warnings: string[];
};

/** The API process's environment, and where it was read: Compose's resolved `api` service, or the environment `doctor` runs in. */
export type ApiEnvironment = { source: 'compose' | 'process'; env: Env };

/** The engine's own Transactions on a chain since a time: how many, and the hashes of the latest few. */
export type RecentTransactions = { count: number; latestHashes: string[] };

export type DatabaseReads = {
  ping: () => Promise<void>;
  /** Tags of migrations in `drizzle/` the database has not applied. */
  pendingMigrations: () => Promise<string[]>;
  recentTransactions: (chain: Chain, since: Date) => Promise<RecentTransactions>;
  /** Every stored Known Asset row (ADR-0061). */
  knownAssets: () => Promise<KnownAsset[]>;
  /** ADR-0064: the nonces of a Sender's wallet the worker found another sender used since `since`. */
  foreignActivity: (
    chain: Chain,
    senderAddress: string,
    since: Date,
  ) => Promise<ForeignActivity | null>;
};

/**
 * Everything a check can read, injected so every check runs against fakes.
 * A check reads only the fields it needs.
 */
export type CheckContext = {
  env: Env;
  config: Config;
  settings: Settings;
  database: DatabaseReads;
  chain: (chain: Chain) => ChainReads;
  /** Absent where the place has no Signer. */
  signer?: { readPins: (address: string) => Promise<PolicyRead> };
  multisigStartup: (sender: SenderSetup) => Promise<MultisigStartup>;
  apiEnvironment: () => Promise<ApiEnvironment>;
  consoleBuilt: () => boolean;
  now: () => Date;
};

type Awaitable<T> = T | Promise<T>;

type CheckHeader = { id: string; area: Area; title: string; runsIn: readonly Place[] };

/** An engine check runs once, a chain check once per enabled chain, and a Sender check once per Sender it applies to (ADR-0060). */
export type Check =
  | (CheckHeader & { scope: 'engine'; run(context: CheckContext): Awaitable<CheckResult> })
  | (CheckHeader & {
      scope: 'chain';
      run(context: CheckContext, chain: Chain): Awaitable<CheckResult>;
    })
  | (CheckHeader & {
      scope: 'sender';
      appliesTo(sender: SenderSetup): boolean;
      run(context: CheckContext, sender: SenderSetup): Awaitable<CheckResult>;
    });

export const pass = (finding: string): CheckResult => ({ status: 'pass', finding });
export const warn = (finding: string, fix: Fix): CheckResult => ({ status: 'warn', finding, fix });
export const fail = (finding: string, fix: Fix): CheckResult => ({ status: 'fail', finding, fix });
