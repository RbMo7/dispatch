import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { Connection } from '@solana/web3.js';
import pino from 'pino';
import { createPublicClient, http, TransactionReceiptNotFoundError, type Hex } from 'viem';

import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import { parseBaseKnownTokens } from '../chain-handler/base/known-tokens.js';
import { readSafeState } from '../chain-handler/base/safe/safe-reads.js';
import { SafeTxServiceClient } from '../chain-handler/base/safe/tx-service-client.js';
import type { ChainHandler } from '../chain-handler/chain-handler.js';
import { parseSolanaKnownTokens } from '../chain-handler/solana/known-tokens.js';
import { readMultisigState } from '../chain-handler/solana/multisig/multisig-account.js';
import { SolanaChainHandler } from '../chain-handler/solana/solana-chain-handler.js';
import { configFrom, type Config, type Env } from '../config.js';
import type { Chain } from '../domain/chain.js';
import { err } from '../domain/result.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { fetchWithTimeout } from '../rpc-timeout.js';
import { SignerClient, type PolicyRead } from '../signer/client.js';
import { ENGINE_WEB_ROOT } from '../web-static.js';
import type { ApiEnvironment, ChainReads, CheckContext, MultisigStartup } from './check.js';
import { safeStartup, squadsStartup } from './multisig-startup.js';
import { postgresReads } from './postgres-reads.js';
import { readSettings, type SenderAccounts, type SenderSetup } from './settings.js';
import { errorText } from './wording.js';

/** Under the per-check timeout, so a hung read is aborted before its check is given up on. */
const MAX_READ_TIMEOUT_MS = 8_000;
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const silent = pino({ level: 'silent' });

function memo<K, V>(make: (key: K) => V): (key: K) => V {
  const cache = new Map<K, V>();
  return (key) => {
    if (!cache.has(key)) cache.set(key, make(key));
    return cache.get(key)!;
  };
}

/**
 * The context `doctor` runs the `cli` checks in, and the worker its `worker`
 * checks: this process's environment, and each read made for real. Reads are
 * remembered for the context's life, so a long-lived caller builds one per run.
 */
export function cliContext(env: Env): { context: CheckContext; close: () => Promise<void> } {
  const config = configFrom(env);
  const settings = readSettings(config);
  const timeoutMs =
    config.rpcTimeoutMs > 0
      ? Math.min(config.rpcTimeoutMs, MAX_READ_TIMEOUT_MS)
      : MAX_READ_TIMEOUT_MS;
  const database = postgresReads(config.databaseUrl, timeoutMs);
  const signer = new SignerClient(config.signerUrl, config.signerAuthToken, timeoutMs);
  // A balance read takes its address; the handler it goes through only needs to be buildable, so any Sender's accounts do.
  const chains = memo((chain: Chain) =>
    CHAIN_READS[chain](
      config,
      timeoutMs,
      settings.senders.find((sender) => sender.chain === chain && sender.accounts)?.accounts,
    ),
  );
  let apiEnvironment: Promise<ApiEnvironment> | undefined;

  const context: CheckContext = {
    env,
    config,
    settings,
    database,
    chain: (chain) => chains(chain).reads,
    signer: { readPins: memo((address: string): Promise<PolicyRead> => signer.readPins(address)) },
    multisigStartup: memo((setup: SenderSetup): Promise<MultisigStartup> =>
      chains(setup.chain).multisigStartup(setup, (address) => context.signer!.readPins(address)),
    ),
    apiEnvironment: () => (apiEnvironment ??= composeApiEnvironment(env, timeoutMs)),
    consoleBuilt: () => existsSync(ENGINE_WEB_ROOT),
    now: () => new Date(),
  };
  return { context, close: () => database.close() };
}

type ChainAccess = {
  reads: ChainReads;
  multisigStartup: (
    setup: SenderSetup,
    readPins: (address: string) => Promise<PolicyRead>,
  ) => Promise<MultisigStartup>;
};

/** A handler's own balance read, built once; a handler that cannot be built answers every read with why. */
function balanceFrom(build: () => Promise<ChainHandler>): ChainReads['balance'] {
  let handler: Promise<ChainHandler> | undefined;
  return async (address, asset) => {
    handler ??= build();
    try {
      return await (await handler).getBalance(address, asset);
    } catch (cause) {
      return err({ code: 'RPC_UNAVAILABLE', message: errorText(cause) });
    }
  };
}

type ChainAccessFactory = (
  config: Config,
  timeoutMs: number,
  anySender: SenderAccounts | undefined,
) => ChainAccess;

const CHAIN_READS: Record<Chain, ChainAccessFactory> = {
  solana: (config, timeoutMs, anySender) => {
    let connection: Connection | undefined;
    const connect = () =>
      (connection ??= new Connection(config.solana.rpcUrl, {
        commitment: 'confirmed',
        fetch: fetchWithTimeout(fetch, timeoutMs),
      }));
    let genesisHash: Promise<string> | undefined;
    return {
      reads: {
        network: async () => ({
          chain: 'solana',
          genesisHash: await (genesisHash ??= connect().getGenesisHash()),
        }),
        balance: balanceFrom(() =>
          Promise.resolve(
            new SolanaChainHandler({
              connection: connect(),
              senderAddress: anySender?.address ?? config.solana.senderAddress,
              knownTokens: parseSolanaKnownTokens(config.solana.knownTokens),
              logger: silent,
            }),
          ),
        ),
        feePaid: async (signature) => {
          const transaction = await connect().getTransaction(signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0,
          });
          return transaction?.meta ? BigInt(transaction.meta.fee) : undefined;
        },
      },
      multisigStartup: (setup, readPins) => {
        if (setup.multisig?.kind !== 'squads' || !setup.accounts) {
          throw new Error('not a Squads Sender');
        }
        return squadsStartup({
          config: setup.multisig.config,
          senderAddress: setup.accounts.address,
          readMultisig: (address) => readMultisigState(connect(), address),
          readSignerPins: readPins,
        });
      },
    };
  },
  base: (config, timeoutMs, anySender) => {
    const fetchFn = fetchWithTimeout(fetch, timeoutMs);
    let client: ReturnType<typeof createPublicClient> | undefined;
    const connect = () =>
      (client ??= createPublicClient({
        transport: http(config.base.rpcUrl, { fetchFn, retryCount: 0 }),
      }));
    let chainId: Promise<number> | undefined;
    return {
      reads: {
        network: async () => ({
          chain: 'base',
          chainId: await (chainId ??= connect().getChainId()),
        }),
        balance: balanceFrom(() =>
          BaseChainHandler.create({
            rpcUrl: config.base.rpcUrl,
            chainId: config.base.chainId,
            senderAddress: anySender?.feePayer ?? config.base.senderAddress,
            knownTokens: parseBaseKnownTokens(config.base.knownTokens),
            nonceHistoryStore: new InMemoryNonceHistoryStore(),
            fetch: fetchFn,
            logger: silent,
          }),
        ),
        feePaid: async (hash) => {
          try {
            const receipt = await connect().getTransactionReceipt({ hash: hash as Hex });
            return receipt.gasUsed * receipt.effectiveGasPrice + l1Fee(receipt);
          } catch (cause) {
            if (cause instanceof TransactionReceiptNotFoundError) return undefined;
            throw cause;
          }
        },
      },
      multisigStartup: (setup, readPins) => {
        if (setup.multisig?.kind !== 'safe') throw new Error('not a Safe Sender');
        const safe = setup.multisig.config;
        return safeStartup({
          config: safe,
          chainId: config.base.chainId,
          service: new SafeTxServiceClient({
            baseUrl: safe.txServiceUrl,
            apiKey: safe.apiKey,
            timeoutMs,
          }),
          readSafe: (address) => readSafeState(connect(), address),
          readSignerPins: readPins,
        });
      },
    };
  },
};

/** An OP Stack receipt also charges for posting the transaction to L1; viem leaves the field as the node sent it. */
function l1Fee(receipt: object): bigint {
  const fee = (receipt as { l1Fee?: unknown }).l1Fee;
  if (typeof fee === 'bigint') return fee;
  return typeof fee === 'string' ? BigInt(fee) : 0n;
}

/**
 * Compose's resolved `api` service, which blanks the Signer settings for the
 * API (ADR-0059). Without Docker or a Compose file, the environment `doctor`
 * runs in is the one `pnpm dev:api` would start with.
 */
async function composeApiEnvironment(env: Env, timeoutMs: number): Promise<ApiEnvironment> {
  try {
    const { stdout } = await promisify(execFile)(
      'docker',
      ['compose', 'config', '--format', 'json'],
      { cwd: REPO_ROOT, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    const parsed = JSON.parse(stdout) as {
      services?: { api?: { environment?: Record<string, string | null> } };
    };
    const api = parsed.services?.api?.environment;
    if (api) {
      return {
        source: 'compose',
        env: Object.fromEntries(Object.entries(api).map(([name, value]) => [name, value ?? ''])),
      };
    }
  } catch {
    // No Docker or no Compose file: fall through to this process's environment.
  }
  return { source: 'process', env };
}
