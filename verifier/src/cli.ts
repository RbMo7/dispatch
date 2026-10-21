import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { RpcError, UsageError, redact } from './errors.js';
import { JsonRpc } from './jsonrpc.js';
import {
  isEvmAddress,
  isSolanaAddress,
  readPaymentsFile,
  type Chain,
  type Payment,
} from './payments.js';
import { render, type Report } from './report.js';
import { evmRpc, type EvmRpc } from './safe/rpc.js';
import { httpService, type ServiceClient } from './safe/service.js';
import { verifySafe } from './safe/verify.js';
import type { AccountReader } from './squads/instructions.js';
import { genesisHash, solanaReader } from './squads/rpc.js';
import { verifySquads } from './squads/verify.js';

export const EXIT_MATCH = 0;
export const EXIT_MISMATCH = 1;
export const EXIT_ERROR = 2;

export const USAGE = `Usage:
  verifier verify --chain solana --rpc-url <url> --proposal <proposal address> --payments <file>
  verifier verify --chain base   --rpc-url <url> --safe <address> (--safe-tx-hash <hash> | --nonce <n> --tx-service-url <url>) --payments <file>

Options:
  --chain           solana (Squads v4) or base (Safe)
  --rpc-url         JSON-RPC endpoint (or set VERIFIER_RPC_URL; it is never printed)
  --payments        your own payment file (.csv or .json: recipient, asset, amount in base units)
  --proposal        Squads: the proposal account address
  --safe            Safe: the Safe address
  --safe-tx-hash    Safe: the safeTxHash the owners see
  --nonce           Safe: the proposal's nonce (default: the Safe's current nonce)
  --bundle-size     Safe: payments per proposal in your file's consecutive chunks (default 50)
  --tx-service-url  Safe, optional: Safe Transaction Service base URL, to decode and cross-check the proposal

Exit code: 0 MATCH, 1 MISMATCH, 2 usage or RPC error.`;

export interface Deps {
  solanaReader(rpcUrl: string): { read: AccountReader; cluster: () => Promise<string | undefined> };
  evmRpc(rpcUrl: string): EvmRpc;
  service(url: string): ServiceClient;
}

export const realDeps: Deps = {
  solanaReader(url) {
    const rpc = new JsonRpc(url);
    return { read: solanaReader(rpc), cluster: () => genesisHash(rpc) };
  },
  evmRpc: (url) => evmRpc(new JsonRpc(url)),
  service: (url) => httpService(url),
};

export interface Io {
  out(text: string): void;
  err(text: string): void;
  env: Record<string, string | undefined>;
}

function bundleSize(raw: string | undefined, chain: Chain): number {
  if (raw === undefined) return chain === 'base' ? 50 : 12;
  if (!/^[0-9]+$/.test(raw) || Number(raw) < 1 || Number(raw) > 10_000)
    throw new UsageError('--bundle-size must be a whole number between 1 and 10000');
  return Number(raw);
}

async function verify(args: string[], io: Io, deps: Deps): Promise<Report> {
  const { values } = parseArgs({
    args,
    options: {
      chain: { type: 'string' },
      'rpc-url': { type: 'string' },
      payments: { type: 'string' },
      proposal: { type: 'string' },
      safe: { type: 'string' },
      'safe-tx-hash': { type: 'string' },
      nonce: { type: 'string' },
      'bundle-size': { type: 'string' },
      'tx-service-url': { type: 'string' },
    },
    strict: true,
  });
  const chain = values.chain;
  if (chain !== 'solana' && chain !== 'base')
    throw new UsageError('--chain must be "solana" or "base"');
  const rpcUrl = values['rpc-url'] ?? io.env.VERIFIER_RPC_URL;
  if (!rpcUrl) throw new UsageError('give --rpc-url (or set VERIFIER_RPC_URL)');
  if (!/^https?:\/\//.test(rpcUrl))
    throw new UsageError('the RPC URL must start with http:// or https://');
  if (!values.payments) throw new UsageError('give --payments <file>');
  const payments: Payment[] = readPaymentsFile(values.payments, chain);

  if (chain === 'solana') {
    const proposal = values.proposal;
    if (!proposal || !isSolanaAddress(proposal))
      throw new UsageError('--proposal must be the Squads proposal account address');
    for (const flag of ['safe', 'safe-tx-hash', 'nonce', 'tx-service-url'] as const) {
      if (values[flag] !== undefined) throw new UsageError(`--${flag} is only for --chain base`);
    }
    const { read, cluster } = deps.solanaReader(rpcUrl);
    bundleSize(values['bundle-size'], 'solana'); // validated only: Squads proposals are checked as subsets, with no chunking
    return verifySquads({ proposal, payments, read, cluster: await cluster() });
  }

  const safe = values.safe;
  if (!safe || !isEvmAddress(safe)) throw new UsageError('--safe must be the Safe address (0x...)');
  if (values.proposal !== undefined) throw new UsageError('--proposal is only for --chain solana');
  const hash = values['safe-tx-hash'];
  if (hash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(hash))
    throw new UsageError('--safe-tx-hash must be 0x followed by 64 hex characters');
  const nonceRaw = values.nonce;
  if (nonceRaw !== undefined && !/^[0-9]+$/.test(nonceRaw))
    throw new UsageError('--nonce must be a whole number');
  if (hash === undefined && (nonceRaw === undefined || values['tx-service-url'] === undefined)) {
    throw new UsageError(
      'give --safe-tx-hash (what the owners see in the Safe app), or --nonce with --tx-service-url',
    );
  }
  const serviceUrl = values['tx-service-url'];
  return verifySafe({
    safe,
    payments,
    bundleSize: bundleSize(values['bundle-size'], 'base'),
    rpc: deps.evmRpc(rpcUrl),
    safeTxHash: hash,
    nonce: nonceRaw === undefined ? undefined : BigInt(nonceRaw),
    service: serviceUrl ? deps.service(serviceUrl) : undefined,
  });
}

/** Run the CLI and return the exit code. Nothing in here prints the RPC URL. */
export async function main(argv: string[], io: Io, deps: Deps = realDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.out(USAGE);
    return command === undefined ? EXIT_ERROR : EXIT_MATCH;
  }
  const secrets = [
    io.env.VERIFIER_RPC_URL ?? '',
    ...rest.flatMap((a, i) =>
      rest[i - 1] === '--rpc-url' || rest[i - 1] === '--tx-service-url' ? [a] : [],
    ),
    ...rest
      .filter((a) => a.startsWith('--rpc-url=') || a.startsWith('--tx-service-url='))
      .map((a) => a.slice(a.indexOf('=') + 1)),
  ];
  try {
    if (command !== 'verify') throw new UsageError(`unknown command "${command}"`);
    const report = await verify(rest, io, deps);
    io.out(redact(render(report), secrets));
    return report.verdict === 'MATCH' ? EXIT_MATCH : EXIT_MISMATCH;
  } catch (e) {
    const message = redact((e as Error).message, secrets);
    if (e instanceof UsageError) io.err(`error: ${message}\n\n${USAGE}`);
    else if (e instanceof RpcError) io.err(`error: ${message}`);
    else if ((e as { code?: string }).code?.startsWith('ERR_PARSE_ARGS'))
      io.err(`error: ${message}\n\n${USAGE}`);
    else io.err(`error: ${message}`);
    return EXIT_ERROR;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), {
    out: (t) => console.log(t),
    err: (t) => console.error(t),
    env: process.env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      console.error(`error: ${(e as Error).message}`);
      process.exitCode = EXIT_ERROR;
    },
  );
}
