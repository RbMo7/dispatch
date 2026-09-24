import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from '@solana/spl-token';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

/**
 * Real solana-devnet fixtures for SolanaChainHandler's tests (ADR-0013: no
 * fake chain behavior for a Chain Handler, ever). A funded wallet and a test
 * SPL mint are provisioned once and cached on disk (`.devnet-fixtures/`,
 * gitignored) so re-running the suite doesn't re-request an airdrop or
 * re-create a mint every time — devnet's faucet is rate-limited and a mint
 * persists on-chain forever anyway.
 */

export const DEVNET_RPC_URL = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';

const FIXTURES_DIR = path.resolve(process.cwd(), '.devnet-fixtures');
const SENDER_KEYPAIR_PATH = path.join(FIXTURES_DIR, 'sender-keypair.json');
const MINT_PATH = path.join(FIXTURES_DIR, 'test-mint.json');

const MIN_SENDER_BALANCE_LAMPORTS = 1.5 * LAMPORTS_PER_SOL;
const TEST_MINT_DECIMALS = 6;

let sharedConnection: Connection | undefined;

/** One shared Connection per test process — devnet RPC is a rate-limited shared resource, no reason to open more than one. */
export function getDevnetConnection(): Connection {
  sharedConnection ??= new Connection(DEVNET_RPC_URL, 'confirmed');
  return sharedConnection;
}

function loadOrCreateKeypair(filePath: string): Keypair {
  if (existsSync(filePath)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(filePath, 'utf8')) as number[]);
    return Keypair.fromSecretKey(secret);
  }
  const keypair = Keypair.generate();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let fundedSenderPromise: Promise<Keypair> | undefined;

/**
 * The Sender wallet every solana-chain-handler test runs against — cached
 * on disk and topped up via devnet airdrop only when its balance actually
 * runs low, never regenerated on every run.
 */
export function getFundedSenderKeypair(): Promise<Keypair> {
  fundedSenderPromise ??= (async () => {
    const keypair = loadOrCreateKeypair(SENDER_KEYPAIR_PATH);
    const connection = getDevnetConnection();

    let balance = await connection.getBalance(keypair.publicKey);
    let attempts = 0;
    while (balance < MIN_SENDER_BALANCE_LAMPORTS && attempts < 6) {
      attempts++;
      try {
        const signature = await connection.requestAirdrop(keypair.publicKey, 2 * LAMPORTS_PER_SOL);
        const latest = await connection.getLatestBlockhash();
        await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
      } catch {
        // devnet's faucet is frequently rate-limited or briefly unavailable;
        // back off and re-check the real balance rather than failing fast.
        await sleep(4000);
      }
      balance = await connection.getBalance(keypair.publicKey);
    }

    if (balance < MIN_SENDER_BALANCE_LAMPORTS) {
      throw new Error(
        `devnet test sender ${keypair.publicKey.toBase58()} only has ${balance} lamports after ${attempts} airdrop attempts. ` +
          `Fund it manually (e.g. \`solana airdrop 2 ${keypair.publicKey.toBase58()} --url devnet\`) and re-run.`,
      );
    }

    return keypair;
  })();
  return fundedSenderPromise;
}

type CachedMint = { mint: string };

let testMintPromise: Promise<PublicKey> | undefined;

/**
 * A devnet SPL token mint owned by the test Sender, used as the "USDC-like"
 * asset for SPL-transfer tests (issue 03) — not real USDC, since minting
 * requires an authority we don't have; a self-owned test mint exercises the
 * exact same `createTransferCheckedInstruction` path with the same failure
 * modes (decimals mismatch, insufficient balance) that a real token would.
 */
export function getTestMint(): Promise<PublicKey> {
  testMintPromise ??= (async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();

    if (existsSync(MINT_PATH)) {
      const cached = JSON.parse(readFileSync(MINT_PATH, 'utf8')) as CachedMint;
      return new PublicKey(cached.mint);
    }

    const mint = await createMint(connection, sender, sender.publicKey, null, TEST_MINT_DECIMALS);

    const senderAta = await getOrCreateAssociatedTokenAccount(
      connection,
      sender,
      mint,
      sender.publicKey,
    );
    await mintTo(
      connection,
      sender,
      mint,
      senderAta.address,
      sender,
      1_000_000_000 * 10 ** TEST_MINT_DECIMALS,
    );

    mkdirSync(path.dirname(MINT_PATH), { recursive: true });
    writeFileSync(MINT_PATH, JSON.stringify({ mint: mint.toBase58() } satisfies CachedMint));
    return mint;
  })();
  return testMintPromise;
}

export function testMintDecimals(): number {
  return TEST_MINT_DECIMALS;
}

// --- In-process reference-style Signer (ADR-0002's `/sign` contract) -------
//
// A real HTTP service, exactly like reference-signer's actual shape, so
// SolanaChainHandler's SignerClient wiring is tested against a real network
// round-trip rather than an in-process fake object — it just happens to be
// started in-process for test convenience instead of via docker-compose.
// Signs with Node's built-in crypto only, matching reference-signer's own
// ADR-0002-spirited "no signing SDK" discipline. This file is test-only and
// is never imported by SolanaChainHandler itself.

const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function signEd25519(seed: Buffer, message: Buffer): Buffer {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  return nodeSign(null, message, key);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) chunks.push(chunk);
  return Buffer.concat(chunks);
}

export type TestSignerHandle = {
  url: string;
  close: () => Promise<void>;
};

/**
 * Starts a real local HTTP `/sign` server keyed by base58 address -> ed25519
 * seed, for whichever keypairs the caller registers. Returns the base URL to
 * hand to a real `SignerClient`.
 */
export async function startTestSigner(keypairs: Keypair[]): Promise<TestSignerHandle> {
  const seedsByAddress = new Map<string, Buffer>(
    keypairs.map((kp) => [kp.publicKey.toBase58(), Buffer.from(kp.secretKey.slice(0, 32))]),
  );

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
        if (body.curve !== 'ed25519') {
          res
            .writeHead(400, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: `unsupported curve: ${String(body.curve)}` }));
          return;
        }
        const seed = body.address ? seedsByAddress.get(body.address) : undefined;
        if (!seed || typeof body.unsignedTxBytes !== 'string') {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ error: `no key for address ${String(body.address)}` }));
          return;
        }
        const message = Buffer.from(body.unsignedTxBytes, 'base64');
        const signature = signEd25519(seed, message);
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
