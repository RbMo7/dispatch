import { isAddress } from 'viem';

import {
  NATIVE_ASSET_SYMBOL as BASE_NATIVE_ASSET,
  parseBaseKnownTokens,
} from '../chain-handler/base/known-tokens.js';
import {
  resolveBaseSafeConfig,
  type BaseSafeConfig,
} from '../chain-handler/base/safe/safe-config.js';
import {
  NATIVE_ASSET_SYMBOL as SOLANA_NATIVE_ASSET,
  parseSolanaKnownTokens,
} from '../chain-handler/solana/known-tokens.js';
import {
  parsePublicKey,
  resolveSolanaMultisigConfig,
  type SolanaMultisigConfig,
} from '../chain-handler/solana/multisig/multisig-config.js';
import { parseEnabledChains } from '../chain-registry/chain-registry.js';
import type { Config } from '../config.js';
import type { Chain } from '../domain/chain.js';

export type MultisigSetup =
  { kind: 'squads'; config: SolanaMultisigConfig } | { kind: 'safe'; config: BaseSafeConfig };

export type SenderSetup = {
  /** The address payments come from: a plain Sender, a Squads vault or a Safe. */
  address: string;
  /** The key the Signer holds and that pays the fees: the Sender itself, or a Multisig Sender's engine key. */
  feePayer: string;
  native: { symbol: string; decimals: number };
  tokens: { symbol: string; decimals: number }[];
};

/** One enabled chain. `sender` and `multisig` are absent while the chain's configuration has problems, so no check reads a half-parsed address. */
export type ChainSetup = { chain: Chain; sender?: SenderSetup; multisig?: MultisigSetup };

export type Settings = {
  /** Every configuration problem, each naming its variable and never a secret's value. */
  problems: string[];
  enabledChains: Chain[];
  chains: ChainSetup[];
};

const SENDER_VARIABLE: Record<Chain, string> = {
  solana: 'SOLANA_SENDER_ADDRESS',
  base: 'BASE_SENDER_ADDRESS',
};

export function senderVariable(chain: Chain): string {
  return SENDER_VARIABLE[chain];
}

/** Runs the engine's own parsers over `config` and collects what each rejects. */
export function readSettings(config: Config): Settings {
  const problems: string[] = [];
  const enabledChains = config.enabledChains
    .split(',')
    .flatMap((name) => attempt(problems, () => parseEnabledChains(name)) ?? []);

  checkUrl(problems, 'DATABASE_URL', config.databaseUrl);
  checkUrl(problems, 'SIGNER_URL', config.signerUrl);
  checkWholeNumber(problems, 'PORT', config.port, 1);
  checkWholeNumber(problems, 'RPC_TIMEOUT_MS', config.rpcTimeoutMs, 1);

  const chains = enabledChains.map((chain): ChainSetup => {
    const chainProblems: string[] = [];
    const sender = CHAIN_READERS[chain](config, chainProblems);
    problems.push(...chainProblems);
    return chainProblems.length === 0 && sender ? { chain, ...sender } : { chain };
  });

  return { problems, enabledChains, chains };
}

type ChainReader = (config: Config, problems: string[]) => Omit<ChainSetup, 'chain'> | undefined;

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
    const multisig = attempt(problems, () => resolveSolanaMultisigConfig(config.solana.multisig), {
      splitLines: true,
    });
    const address = config.solana.senderAddress.trim();
    if (multisig === undefined && address !== '' && !parsePublicKey(address)) {
      problems.push(`SOLANA_SENDER_ADDRESS is not a base58 Solana address`);
    }
    if (address === '' || tokens === undefined) return undefined;
    return {
      sender: {
        address,
        feePayer: multisig?.memberAddress ?? address,
        native: { symbol: SOLANA_NATIVE_ASSET, decimals: 9 },
        tokens: tokenList(tokens),
      },
      ...(multisig ? { multisig: { kind: 'squads' as const, config: multisig } } : {}),
    };
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
    const safe = attempt(
      problems,
      () => resolveBaseSafeConfig(config.base.safe, config.base.chainId),
      { splitLines: true },
    );
    const executor = config.base.senderAddress.trim();
    if (safe === undefined && executor !== '' && !isAddress(executor, { strict: false })) {
      problems.push('BASE_SENDER_ADDRESS is not an EVM address');
    }
    if (executor === '' || tokens === undefined) return undefined;
    return {
      sender: {
        address: safe?.safeAddress ?? executor,
        feePayer: executor,
        native: { symbol: BASE_NATIVE_ASSET, decimals: 18 },
        tokens: tokenList(tokens),
      },
      ...(safe ? { multisig: { kind: 'safe' as const, config: safe } } : {}),
    };
  },
};

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

function tokenList(
  registry: Readonly<Record<string, { decimals: number }>>,
): SenderSetup['tokens'] {
  return Object.entries(registry).map(([symbol, { decimals }]) => ({ symbol, decimals }));
}
