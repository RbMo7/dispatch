import { isAddress } from 'viem';

import { parseBaseKnownTokens } from '../chain-handler/base/known-tokens.js';
import {
  resolveBaseSafeConfig,
  type BaseSafeConfig,
} from '../chain-handler/base/safe/safe-config.js';
import { parseSolanaKnownTokens } from '../chain-handler/solana/known-tokens.js';
import {
  parsePublicKey,
  resolveSolanaMultisigConfig,
  type SolanaMultisigConfig,
} from '../chain-handler/solana/multisig/multisig-config.js';
import { parseEnabledChains } from '../chain-registry/chain-registry.js';
import type { Config } from '../config.js';
import type { Chain } from '../domain/chain.js';
import { NATIVE_ASSETS } from '../domain/known-asset.js';
import type { SenderName } from '../domain/sender.js';
import {
  parseSendersConfig,
  readSendersSource,
  type BaseSenderSpec,
  type SenderSpec,
  type SendersConfig,
  type SendersSource,
  type SolanaSenderSpec,
} from '../senders-config.js';
import { CHAIN_NAMES } from './wording.js';

export type MultisigSetup =
  { kind: 'squads'; config: SolanaMultisigConfig } | { kind: 'safe'; config: BaseSafeConfig };

export type SenderAccounts = {
  /** The address payments come from: a plain Sender, a Squads vault or a Safe. */
  address: string;
  /** The key the Signer holds and that pays the fees: the Sender itself, or a Multisig Sender's engine key. */
  feePayer: string;
  native: { symbol: string; decimals: number };
};

/**
 * One configured Sender (ADR-0060). `name` is null for the one Sender
 * today's variables describe when there is no senders file, so its checks
 * read exactly as they did before Senders had names. `accounts` and
 * `multisig` are absent while its configuration has problems, so no check
 * reads a half-parsed address.
 */
export type SenderSetup = {
  chain: Chain;
  name: SenderName | null;
  /** A Dispatch that names no Sender pays from this one. */
  isDefault: boolean;
  accounts?: SenderAccounts;
  multisig?: MultisigSetup;
};

export type Settings = {
  /** Every configuration problem, each naming its variable and never a secret's value. */
  problems: string[];
  /** Settings the senders file makes the engine ignore. */
  warnings: string[];
  /** The senders file the Senders come from; undefined when today's variables describe them. */
  sendersFile: string | undefined;
  enabledChains: Chain[];
  /** Every Sender of every enabled chain, by chain in `ENABLED_CHAINS` order. */
  senders: SenderSetup[];
};

const SENDER_VARIABLE: Record<Chain, string> = {
  solana: 'SOLANA_SENDER_ADDRESS',
  base: 'BASE_SENDER_ADDRESS',
};

export function senderVariable(chain: Chain): string {
  return SENDER_VARIABLE[chain];
}

/** "Solana" for the single Sender of today's variables, "refunds on Solana" for a named one. */
export function senderLabel({ chain, name }: Pick<SenderSetup, 'chain' | 'name'>): string {
  return name === null ? CHAIN_NAMES[chain] : `${name} on ${CHAIN_NAMES[chain]}`;
}

/**
 * Runs the engine's own parsers over `config` and collects what each
 * rejects. The Senders come from the senders-file parser the engine starts
 * with, so every Sender it would load is checked, and only those.
 */
export function readSettings(
  config: Config,
  readSource: () => SendersSource = () => readSendersSource(config.sendersFile),
): Settings {
  const problems: string[] = [];
  const enabledChains = config.enabledChains
    .split(',')
    .flatMap((name) => attempt(problems, () => parseEnabledChains(name)) ?? []);

  checkUrl(problems, 'DATABASE_URL', config.databaseUrl);
  checkUrl(problems, 'SIGNER_URL', config.signerUrl);
  checkWholeNumber(problems, 'PORT', config.port, 1);
  checkWholeNumber(problems, 'RPC_TIMEOUT_MS', config.rpcTimeoutMs, 1);

  const basics = new Map(
    enabledChains.map((chain) => {
      const chainProblems: string[] = [];
      const read = CHAIN_READERS[chain](config, chainProblems);
      problems.push(...chainProblems);
      return [chain, chainProblems.length === 0 ? read : undefined] as const;
    }),
  );

  const source = attempt(problems, readSource);
  const parsed = source && parseSenders(problems, source, enabledChains, config);
  const senders = (parsed?.chains ?? []).flatMap(({ default: defaultName, senders: specs }) =>
    specs.map((spec) => ({
      ...readSender(problems, config, spec, parsed!.source, basics),
      isDefault: spec.name === defaultName,
    })),
  );
  return {
    problems,
    warnings: parsed?.warnings ?? [],
    sendersFile: source?.kind === 'file' ? source.path : undefined,
    enabledChains,
    senders,
  };
}

/** The engine's senders-file parser; each problem in a file is one problem here, naming SENDERS_FILE. */
function parseSenders(
  problems: string[],
  source: SendersSource,
  enabledChains: readonly Chain[],
  config: Config,
): SendersConfig | undefined {
  try {
    return parseSendersConfig({
      source,
      enabledChains,
      variables: { solana: config.solana.multisig, base: config.base.safe },
    });
  } catch (cause) {
    const where = source.kind === 'file' ? source.path : 'the variables';
    const [first = '', ...listed] = (cause instanceof Error ? cause.message : String(cause)).split(
      '\n',
    );
    const lines = listed.length > 0 ? listed : [first];
    problems.push(
      ...lines.map((line) => `SENDERS_FILE (${where}): ${line.replace(/^\s*-\s*/, '').trim()}`),
    );
    return undefined;
  }
}

function readSender(
  problems: string[],
  config: Config,
  spec: SenderSpec,
  source: SendersConfig['source'],
  basics: ReadonlyMap<Chain, ChainBasics | undefined>,
): Omit<SenderSetup, 'isDefault'> {
  const { chain } = spec;
  const name = source === 'file' ? spec.name : null;
  const senderProblems: string[] = [];
  const read =
    spec.chain === 'solana'
      ? readSolanaSender(spec, senderProblems)
      : readBaseSender(config, spec, senderProblems);
  problems.push(
    ...(name === null
      ? senderProblems
      : senderProblems.map((problem) => `${chain} sender "${name}": ${problem}`)),
  );
  const chainBasics = basics.get(chain);
  if (senderProblems.length > 0 || !read || !chainBasics) return { chain, name };
  return {
    chain,
    name,
    accounts: { address: read.address, feePayer: read.feePayer, ...chainBasics },
    ...(read.multisig ? { multisig: read.multisig } : {}),
  };
}

type ChainBasics = Pick<SenderAccounts, 'native'>;

function nativeOf(chain: Chain): SenderAccounts['native'] {
  const { symbol, decimals } = NATIVE_ASSETS[chain];
  return { symbol, decimals };
}
type ChainReader = (config: Config, problems: string[]) => ChainBasics | undefined;

const CHAIN_READERS: Record<Chain, ChainReader> = {
  solana: (config, problems) => {
    checkUrl(problems, 'SOLANA_RPC_URL', config.solana.rpcUrl);
    checkWholeNumber(problems, 'SOLANA_SEND_CONCURRENCY', config.solana.sendConcurrency, 1);
    if (config.solana.computeUnitPriceMicroLamports !== 'auto') {
      checkWholeNumber(
        problems,
        'SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS',
        config.solana.computeUnitPriceMicroLamports,
        0,
      );
    } else if (!(config.solana.maxComputeUnitPriceMicroLamports > 0)) {
      problems.push(
        'SOLANA_MAX_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS must be above 0 when SOLANA_COMPUTE_UNIT_PRICE_MICRO_LAMPORTS is auto',
      );
    }
    const tokens = attempt(problems, () => parseSolanaKnownTokens(config.solana.knownTokens));
    return tokens && { native: nativeOf('solana') };
  },
  base: (config, problems) => {
    checkUrl(problems, 'BASE_RPC_URL', config.base.rpcUrl);
    if (config.base.traceRpcUrl !== '')
      checkUrl(problems, 'BASE_TRACE_RPC_URL', config.base.traceRpcUrl);
    checkWholeNumber(problems, 'BASE_CHAIN_ID', config.base.chainId, 1);
    checkWholeNumber(problems, 'BASE_FEE_BUMP_PERCENT', config.base.feeBumpPercent, 0);
    checkWholeNumber(problems, 'BASE_STUCK_AFTER_MS', config.base.stuckAfterMs, 1);
    checkWholeNumber(problems, 'BASE_MAX_FEE_BUMPS', config.base.maxFeeBumps, 0);
    checkWholeNumber(
      problems,
      'BASE_BULK_CALL_MAX_BATCH_SIZE',
      config.base.bulkCallMaxBatchSize,
      1,
    );
    const tokens = attempt(problems, () => parseBaseKnownTokens(config.base.knownTokens));
    return tokens && { native: nativeOf('base') };
  },
};

type SenderRead = { address: string; feePayer: string; multisig?: MultisigSetup };

/** A Sender through the Squads resolver the engine builds it with. */
function readSolanaSender(spec: SolanaSenderSpec, problems: string[]): SenderRead | undefined {
  const multisig = attempt(problems, () => resolveSolanaMultisigConfig(spec.settings), {
    splitLines: true,
  });
  const address = spec.address.trim();
  if (multisig === undefined && address !== '' && !parsePublicKey(address)) {
    problems.push(`SOLANA_SENDER_ADDRESS is not a base58 Solana address`);
  }
  if (address === '') return undefined;
  return {
    address,
    feePayer: multisig?.memberAddress ?? address,
    ...(multisig ? { multisig: { kind: 'squads' as const, config: multisig } } : {}),
  };
}

/** A Sender through the Safe resolver the engine builds it with. */
function readBaseSender(
  config: Config,
  spec: BaseSenderSpec,
  problems: string[],
): SenderRead | undefined {
  const safe = attempt(problems, () => resolveBaseSafeConfig(spec.settings, config.base.chainId), {
    splitLines: true,
  });
  const executor = spec.handlerAddress.trim();
  if (safe === undefined && executor !== '' && !isAddress(executor, { strict: false })) {
    problems.push('BASE_SENDER_ADDRESS is not an EVM address');
  }
  if (executor === '') return undefined;
  return {
    address: safe?.safeAddress ?? executor,
    feePayer: executor,
    ...(safe ? { multisig: { kind: 'safe' as const, config: safe } } : {}),
  };
}

/** Runs one of the engine's throwing parsers, turning its error into problems. A multi-line error lists one problem per line. */
function attempt<T>(
  problems: string[],
  parse: () => T,
  { splitLines = false }: { splitLines?: boolean } = {},
): T | undefined {
  try {
    return parse();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const lines = message.split('\n');
    const listed = lines.slice(1).map((line) => line.replace(/^\s*-\s*/, '').trim());
    problems.push(...(splitLines && listed.length > 0 ? listed : [message]));
    return undefined;
  }
}

/** Names the variable and never echoes it: a URL can carry a password or an API key. */
function checkUrl(problems: string[], variable: string, value: string): void {
  if (!URL.canParse(value)) problems.push(`${variable} is not a URL`);
}

function checkWholeNumber(problems: string[], variable: string, value: number, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) {
    problems.push(`${variable} must be a whole number of at least ${min}`);
  }
}
