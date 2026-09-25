import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { secp256k1 } from '@noble/curves/secp256k1.js';
import solc from 'solc';
import { createPublicClient, createWalletClient, http, type Abi, type Chain } from 'viem';
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

/** A minimal viem `Chain` definition, just enough for a WalletClient to sign/send against Base Sepolia — test-support only, never imported by BaseChainHandler itself. */
const BASE_SEPOLIA: Chain = {
  id: BASE_SEPOLIA_CHAIN_ID,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [BASE_SEPOLIA_RPC_URL] } },
};

const FIXTURES_DIR = path.resolve(process.cwd(), '.base-fixtures');
const TEST_TOKEN_CACHE_PATH = path.join(FIXTURES_DIR, 'test-token.json');
const DEV_SENDER_LOCK_PATH = path.join(FIXTURES_DIR, 'dev-sender.lock');
/** A held lock older than this is assumed abandoned by a crashed process, not a real hold — steal it rather than deadlock every future run. */
const LOCK_STALE_AFTER_MS = 2 * 60_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchTransactionCount(address: string): Promise<number> {
  const response = await fetch(BASE_SEPOLIA_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getTransactionCount',
      params: [address, 'latest'],
    }),
  });
  const body = (await response.json()) as { result?: string; error?: unknown };
  if (!response.ok || body.result === undefined) {
    throw new Error(`eth_getTransactionCount failed (HTTP ${response.status}): ${JSON.stringify(body.error)}`);
  }
  return Number.parseInt(body.result, 16);
}

/**
 * Base Sepolia's public RPC is a multi-node gateway with no
 * read-after-write guarantee across nodes: releasing the dev-sender lock
 * right after a broadcast lets the *next* lock holder's
 * `BaseChainHandler.create()` read a stale nonce from a lagging node,
 * before it's seen this holder's own last broadcast — observed directly,
 * causing a real "nonce too low" failure in the very next file. Waits for
 * two identical back-to-back reads (a cheap, chain-agnostic proxy for "the
 * gateway has converged") before actually releasing, rather than a single
 * read, since a single stale read is exactly the failure mode this exists
 * to prevent.
 */
async function waitForNonceConsistency(address: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let previous: number | undefined;
  while (Date.now() < deadline) {
    const current = await fetchTransactionCount(address);
    if (previous !== undefined && current === previous) return;
    previous = current;
    await sleepMs(1_000);
  }
  throw new Error(`dev-sender nonce for ${address} never read the same twice within 20s — RPC nodes still disagreeing`);
}

/**
 * vitest runs separate test *files* in parallel workers by default — but
 * every base-chain-handler e2e test constructs its own `BaseChainHandler`
 * against the one real dev-sender account, each with its own in-process
 * nonce authority (issue 02) that knows nothing about the others. Two such
 * instances racing to broadcast against the same real account is a
 * genuine cross-process nonce collision (observed directly running the
 * full suite: "nonce too low" broadcast failures) — not a production
 * concern (exactly one BaseChainHandler instance ever exists per Sender
 * per process there), purely an artifact of parallel test files sharing
 * one real account. A plain exclusive-create file lock serializes any
 * such test across processes: `getDevSenderAccount`-using e2e test files
 * `await acquireDevSenderLock()` in `beforeAll` (before constructing a
 * BaseChainHandler) and `await` the returned release function in
 * `afterAll`, holding it for their whole file's real-broadcast lifetime.
 */
/**
 * How long a file waits its turn for the dev-sender lock. Every live
 * broadcasting file queues behind the others (ten, as of #13), so this is
 * sized for the whole queue, not one holder.
 */
export const DEV_SENDER_LOCK_WAIT_MS = 10 * 60_000;
/** The `beforeAll` timeout for a hook that takes the lock: its wait plus room for its own setup. */
export const DEV_SENDER_LOCK_HOOK_TIMEOUT_MS = DEV_SENDER_LOCK_WAIT_MS + 2 * 60_000;

export async function acquireDevSenderLock(): Promise<() => Promise<void>> {
  mkdirSync(FIXTURES_DIR, { recursive: true });
  const deadline = Date.now() + DEV_SENDER_LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(DEV_SENDER_LOCK_PATH, 'wx'));
      return async () => {
        await waitForNonceConsistency(getDevSenderAccount().address);
        rmSync(DEV_SENDER_LOCK_PATH, { force: true });
      };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
      try {
        if (Date.now() - statSync(DEV_SENDER_LOCK_PATH).mtimeMs > LOCK_STALE_AFTER_MS) {
          rmSync(DEV_SENDER_LOCK_PATH, { force: true });
          continue;
        }
      } catch {
        continue; // lock disappeared between the failed create and this stat — just retry
      }
      if (Date.now() > deadline) {
        throw new Error('timed out waiting for the dev-sender test lock — see base-fixtures.ts');
      }
      await sleepMs(250);
    }
  }
}

/**
 * A trivial mintable-in-constructor ERC-20, compiled with `solc` at
 * fixture-setup time — not real USDC (no faucet/authority available for
 * that), but exercises `BaseChainHandler`'s exact `transfer`/`balanceOf`
 * ABI path (ERC20_ABI in erc20.ts) against a token genuinely deployed and
 * live on Base Sepolia, mirroring how solana-chain-handler's own test mint
 * is self-owned rather than real USDC.
 *
 * Also doubles as issue 05's "actual deployed test contract" (a raw,
 * caller-encoded `EvmCall` beyond a plain transfer) — `increment`/`count`/
 * `Incremented` give a real state change + emitted event to check
 * independently of "the transaction confirmed", and `revertAlways` gives a
 * real on-chain revert to prove that path doesn't crash or silently
 * misreport. One deployment covers both issues rather than two.
 */
const TEST_TOKEN_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TestToken {
    mapping(address => uint256) public balanceOf;
    uint256 public count;
    event Incremented(uint256 newCount);

    constructor(uint256 initialSupply) {
        balanceOf[msg.sender] = initialSupply;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function increment() external {
        count += 1;
        emit Incremented(count);
    }

    function revertAlways() external pure {
        require(false, "always reverts");
    }
}
`;

export const TEST_TOKEN_DECIMALS = 6;
const TEST_TOKEN_INITIAL_SUPPLY = 1_000_000n * 10n ** BigInt(TEST_TOKEN_DECIMALS);

/** `solc` ships no types of its own — this is the one call this file makes into it. */
const solcCompile = solc.compile as (input: string) => string;

function compileTestToken(): { abi: Abi; bytecode: `0x${string}` } {
  const input = {
    language: 'Solidity',
    sources: { 'TestToken.sol': { content: TEST_TOKEN_SOURCE } },
    settings: { outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const output = JSON.parse(solcCompile(JSON.stringify(input))) as {
    errors?: { severity: string; formattedMessage: string }[];
    contracts: { 'TestToken.sol': { TestToken: { abi: Abi; evm: { bytecode: { object: string } } } } };
  };
  const fatal = output.errors?.filter((e) => e.severity === 'error');
  if (fatal && fatal.length > 0) {
    throw new Error(`TestToken.sol failed to compile: ${fatal.map((e) => e.formattedMessage).join('\n')}`);
  }
  const contract = output.contracts['TestToken.sol'].TestToken;
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

export type TestTokenInfo = {
  address: `0x${string}`;
  decimals: number;
  abi: Abi;
};

let testTokenPromise: Promise<TestTokenInfo> | undefined;

/**
 * Deploys (or reuses a previously-deployed, disk-cached) TestToken owned by
 * the dev-sender, minting the whole initial supply to itself — cached on
 * disk (`.base-fixtures/`, gitignored) so re-running the suite doesn't
 * redeploy, since a deployed contract persists on-chain forever anyway
 * (mirroring devnet-fixtures.ts's own test-mint caching).
 */
export function getOrDeployTestToken(): Promise<TestTokenInfo> {
  testTokenPromise ??= (async () => {
    const { abi, bytecode } = compileTestToken();

    if (existsSync(TEST_TOKEN_CACHE_PATH)) {
      const cached = JSON.parse(readFileSync(TEST_TOKEN_CACHE_PATH, 'utf8')) as { address: string };
      return { address: cached.address as `0x${string}`, decimals: TEST_TOKEN_DECIMALS, abi };
    }

    const sender = getDevSenderAccount();
    const account = privateKeyToAccount(`0x${sender.privateKeyHex}`);
    const walletClient = createWalletClient({ account, chain: BASE_SEPOLIA, transport: http(BASE_SEPOLIA_RPC_URL) });
    const publicClient = createPublicClient({ chain: BASE_SEPOLIA, transport: http(BASE_SEPOLIA_RPC_URL) });

    const hash = await walletClient.deployContract({
      abi,
      bytecode,
      args: [TEST_TOKEN_INITIAL_SUPPLY],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) {
      throw new Error(`TestToken deployment (tx ${hash}) did not report a contract address`);
    }

    // Base Sepolia's public RPC is a multi-node gateway with no
    // read-after-write guarantee across nodes: `waitForTransactionReceipt`
    // above can confirm against one node while a caller's very next
    // `eth_getTransactionCount` (e.g. BaseChainHandler.create, issue 02)
    // lands on a lagging node that hasn't seen this deployment's nonce yet
    // — observed directly, causing a real "nonce too low" broadcast
    // failure. Only relevant for a fresh deploy (the cached-address path
    // above never sends a transaction), so this wait doesn't tax every run.
    const deployTx = await publicClient.getTransaction({ hash });
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const nextNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });
      if (nextNonce > deployTx.nonce) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    mkdirSync(FIXTURES_DIR, { recursive: true });
    writeFileSync(TEST_TOKEN_CACHE_PATH, JSON.stringify({ address: receipt.contractAddress }));
    return { address: receipt.contractAddress, decimals: TEST_TOKEN_DECIMALS, abi };
  })();
  return testTokenPromise;
}

// --- In-process reference-signer-style Signer (ADR-0002's `/sign` contract) ---
//
// A real HTTP service, exactly like reference-signer's actual secp256k1
// path (same @noble/curves digest-direct, recoverable-signature approach —
// duplicated here rather than imported, mirroring solana-chain-handler's
// own test-support signer, which duplicates its ed25519 signing rather
// than importing reference-signer). This file is test-only and is never
// imported by BaseChainHandler itself.

function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Mirrors reference-signer/src/sign.ts's signSecp256k1: signs an already-final digest directly (no re-hashing), returns r||s||recovery (65 bytes). */
function signSecp256k1Digest(privateKeyHex: string, digest: Buffer): Buffer {
  const scalar = Buffer.from(privateKeyHex, 'hex');
  const signature = secp256k1.sign(digest, scalar, { prehash: false, format: 'recovered' });
  const recovery = signature[0] ?? 0;
  const r = signature.slice(1, 33);
  const s = signature.slice(33, 65);
  return Buffer.concat([r, s, Buffer.from([recovery])]);
}

export type TestSignerHandle = {
  url: string;
  close: () => Promise<void>;
};

/**
 * Starts a real local HTTP `/sign` server keyed by EVM address -> secp256k1
 * private key, for whichever accounts the caller registers. Returns the
 * base URL to hand to a real `SignerClient`.
 */
export async function startTestSigner(
  accounts: { address: `0x${string}`; privateKeyHex: string }[],
): Promise<TestSignerHandle> {
  const keysByAddress = new Map(accounts.map((a) => [a.address.toLowerCase(), a.privateKeyHex]));

  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/sign') {
        res.writeHead(404).end();
        return;
      }
      try {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          curve?: string;
          address?: string;
          unsignedTxBytes?: string;
        };
        if (body.curve !== 'secp256k1') {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: `unsupported curve: ${String(body.curve)}` }));
          return;
        }
        const privateKeyHex = body.address ? keysByAddress.get(body.address.toLowerCase()) : undefined;
        if (!privateKeyHex || typeof body.unsignedTxBytes !== 'string') {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: `no key for address ${String(body.address)}` }));
          return;
        }
        const digest = Buffer.from(body.unsignedTxBytes, 'base64');
        const signature = signSecp256k1Digest(privateKeyHex, digest);
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ signature: signature.toString('base64') }));
      } catch (cause) {
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: cause instanceof Error ? cause.message : String(cause) }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('test signer failed to bind a TCP port');
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
