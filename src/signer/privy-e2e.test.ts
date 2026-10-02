import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type Connection,
} from '@solana/web3.js';
import { createPublicClient, createWalletClient, http, parseEther, type Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount, privateKeyToAddress } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createBackends } from '../../signer/src/backends/index.js';
import { buildSigner } from '../../signer/src/startup.js';
import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import {
  acquireDevSenderLock,
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  DEV_SENDER_LOCK_HOOK_TIMEOUT_MS,
  getDevSenderAccount,
} from '../chain-handler/base/test-support/base-fixtures.js';
import { SolanaChainHandler } from '../chain-handler/solana/solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
} from '../chain-handler/solana/test-support/devnet-fixtures.js';
import type { ChainHandler } from '../chain-handler/chain-handler.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { SignerClient } from './client.js';

/**
 * #55: keys held by Privy server wallets, signing through the real Signer
 * (`signer/`, the `privy` backend) for the engine's real chain handlers, on
 * real Base Sepolia and Solana devnet (ADR-0013).
 *
 * It calls Privy and spends testnet funds, so it only runs when asked,
 * with an operator's own Privy app and two of its server wallets:
 *
 *   RUN_PRIVY=1
 *   PRIVY_APP_ID, PRIVY_APP_SECRET   the app's API credentials
 *   PRIVY_AUTHORIZATION_KEY          the authorization key's private key, as Privy shows it
 *                                    (`wallet-auth:...`)
 *   PRIVY_BASE_WALLET_ID             an Ethereum wallet
 *   PRIVY_SOLANA_WALLET_ID           a Solana wallet
 *
 * Both wallets must be owned by the authorization key: created with
 * `owner: { public_key: <the key's P-256 public key> }`, or with `owner_id`
 * a key quorum holding that key (Privy's dashboard or `wallets().update`
 * can set it later). Privy then refuses any signing request the key hasn't
 * signed, which the last two tests prove by running a Signer without it.
 *
 * The wallets need no funding beforehand: each is topped up from the dev
 * Senders the other live tests use, only when it runs low.
 */
const RUN = process.env.RUN_PRIVY === '1';
const SIGNER_TOKEN = 'privy-e2e-token';

const BASE_MIN_BALANCE = parseEther('0.0002');
const BASE_TOP_UP = parseEther('0.0005');
const SOLANA_MIN_BALANCE = 0.005 * LAMPORTS_PER_SOL;
const SOLANA_TOP_UP = 0.01 * LAMPORTS_PER_SOL;
/** Above the rent-exempt minimum, so a fresh recipient account can hold it. */
const SOLANA_AMOUNT = 1_000_000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RUN_PRIVY=1 needs ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type AuditLine = { decision: string; status: number; address?: string; reason?: string };

type RunningSigner = { client: SignerClient; audit: AuditLine[]; close: () => Promise<void> };

/** The real Signer process's startup, over a config mapping both Privy wallets, listening on a free port. */
async function startSigner(
  env: Record<string, string | undefined>,
  wallets: { base: Address; solana: string },
): Promise<RunningSigner> {
  const config = path.join(mkdtempSync(path.join(tmpdir(), 'privy-e2e-')), 'signer.config.json');
  writeFileSync(
    config,
    JSON.stringify({
      [wallets.base]: {
        curve: 'secp256k1',
        backend: 'privy',
        keyRef: requireEnv('PRIVY_BASE_WALLET_ID'),
      },
      [wallets.solana]: {
        curve: 'ed25519',
        backend: 'privy',
        keyRef: requireEnv('PRIVY_SOLANA_WALLET_ID'),
      },
    }),
  );
  const audit: AuditLine[] = [];
  const server = await buildSigner(
    { ...env, SIGNER_CONFIG: config, SIGNER_AUTH_TOKEN: SIGNER_TOKEN },
    (line) => audit.push(JSON.parse(line) as AuditLine),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    client: new SignerClient(`http://127.0.0.1:${port}`, SIGNER_TOKEN),
    audit,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function topUpBase(address: Address): Promise<void> {
  const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
  if ((await client.getBalance({ address })) >= BASE_MIN_BALANCE) return;
  const release = await acquireDevSenderLock();
  try {
    const wallet = createWalletClient({
      account: privateKeyToAccount(`0x${getDevSenderAccount().privateKeyHex}`),
      chain: baseSepolia,
      transport: http(BASE_SEPOLIA_RPC_URL),
    });
    const hash = await wallet.sendTransaction({ to: address, value: BASE_TOP_UP });
    expect((await client.waitForTransactionReceipt({ hash })).status).toBe('success');
  } finally {
    await release();
  }
}

/** Plain polling, not confirmTransaction, which waits on a websocket some RPCs never deliver on. */
async function waitForSolana(connection: Connection, signature: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status?.err) throw new Error(`${signature} failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await sleep(1_000);
  }
  throw new Error(`${signature} was not confirmed within 60s`);
}

async function topUpSolana(connection: Connection, address: string): Promise<void> {
  const wallet = new PublicKey(address);
  if ((await connection.getBalance(wallet)) >= SOLANA_MIN_BALANCE) return;
  const funder = await getFundedSenderKeypair();
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: wallet,
      lamports: SOLANA_TOP_UP,
    }),
  );
  transaction.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
  transaction.feePayer = funder.publicKey;
  transaction.sign(funder);
  await waitForSolana(connection, await connection.sendRawTransaction(transaction.serialize()));
}

/** Builds a payment from the handler's Sender and has the Signer sign it. */
async function signPayment(
  handler: ChainHandler,
  sender: string,
  payment: { recipient: string; asset: string; amount: string },
) {
  const call = await handler.paymentToCall(payment);
  if (!call.ok) throw new Error(`paymentToCall failed: ${call.error.message}`);
  const prepared = await handler.prepare([call.value], sender);
  if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
  return handler.sign(prepared.value[0], sender);
}

describe.runIf(RUN)('Privy-held keys signing through the real Signer (#55)', () => {
  const privyEnv = () => ({
    PRIVY_APP_ID: requireEnv('PRIVY_APP_ID'),
    PRIVY_APP_SECRET: requireEnv('PRIVY_APP_SECRET'),
    PRIVY_AUTHORIZATION_KEY: requireEnv('PRIVY_AUTHORIZATION_KEY'),
  });
  let wallets: { base: Address; solana: string };
  let signer: RunningSigner;

  beforeAll(async () => {
    const privy = createBackends(['privy'], privyEnv()).get('privy');
    if (!privy) throw new Error('the privy backend was not built');
    wallets = {
      base: (await privy.address('secp256k1', requireEnv('PRIVY_BASE_WALLET_ID'))) as Address,
      solana: await privy.address('ed25519', requireEnv('PRIVY_SOLANA_WALLET_ID')),
    };
    signer = await startSigner(privyEnv(), wallets);
    await Promise.all([
      topUpBase(wallets.base),
      topUpSolana(getDevnetConnection(), wallets.solana),
    ]);
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await signer?.close();
  });

  it('lands a Base Sepolia transfer signed by the Privy wallet', async () => {
    const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: wallets.base,
      signerClient: signer.client,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
    const recipient = privateKeyToAddress(generatePrivateKey());

    const signed = await signPayment(handler, wallets.base, {
      recipient,
      asset: 'ETH',
      amount: '1000',
    });
    if (!signed.ok) throw new Error(`sign failed: ${signed.error.message}`);
    const broadcast = await handler.broadcast(signed.value);
    if (!broadcast.ok) throw new Error(`broadcast failed: ${broadcast.error.message}`);

    const receipt = await client.waitForTransactionReceipt({
      hash: broadcast.value.hash as `0x${string}`,
    });
    expect(receipt.status).toBe('success');
    expect(receipt.from.toLowerCase()).toBe(wallets.base.toLowerCase());
    expect(signer.audit.at(-1)).toMatchObject({ decision: 'signed', address: wallets.base });
  }, 120_000);

  it('lands a Solana devnet transfer signed by the Privy wallet', async () => {
    const connection = getDevnetConnection();
    const handler = new SolanaChainHandler({
      connection,
      signerClient: signer.client,
      senderAddress: wallets.solana,
    });
    const recipient = Keypair.generate().publicKey;

    const signed = await signPayment(handler, wallets.solana, {
      recipient: recipient.toBase58(),
      asset: 'SOL',
      amount: String(SOLANA_AMOUNT),
    });
    if (!signed.ok) throw new Error(`sign failed: ${signed.error.message}`);
    const broadcast = await handler.broadcast(signed.value);
    if (!broadcast.ok) throw new Error(`broadcast failed: ${broadcast.error.message}`);

    expect(await connection.getBalance(recipient)).toBe(SOLANA_AMOUNT);
    expect(signer.audit.at(-1)).toMatchObject({ decision: 'signed', address: wallets.solana });
  }, 120_000);

  describe('a Signer without the authorization key', () => {
    let unauthorized: RunningSigner;

    beforeAll(async () => {
      unauthorized = await startSigner(
        { ...privyEnv(), PRIVY_AUTHORIZATION_KEY: undefined },
        wallets,
      );
    });

    afterAll(async () => {
      await unauthorized?.close();
    });

    it('is refused by Privy for the Base wallet: the Signer answers 500, audited failed', async () => {
      const handler = await BaseChainHandler.create({
        rpcUrl: BASE_SEPOLIA_RPC_URL,
        chainId: BASE_SEPOLIA_CHAIN_ID,
        senderAddress: wallets.base,
        signerClient: unauthorized.client,
        nonceHistoryStore: new InMemoryNonceHistoryStore(),
      });

      const signed = await signPayment(handler, wallets.base, {
        recipient: privateKeyToAddress(generatePrivateKey()),
        asset: 'ETH',
        amount: '1000',
      });

      expect(signed.ok).toBe(false);
      expect(!signed.ok && signed.error.code).toBe('SIGNER_UNREACHABLE');
      expect(unauthorized.audit).toEqual([
        expect.objectContaining({ decision: 'failed', status: 500, address: wallets.base }),
      ]);
    }, 60_000);

    it('is refused by Privy for the Solana wallet: the Signer answers 500, audited failed', async () => {
      const handler = new SolanaChainHandler({
        connection: getDevnetConnection(),
        signerClient: unauthorized.client,
        senderAddress: wallets.solana,
      });

      const signed = await signPayment(handler, wallets.solana, {
        recipient: Keypair.generate().publicKey.toBase58(),
        asset: 'SOL',
        amount: String(SOLANA_AMOUNT),
      });

      expect(signed.ok).toBe(false);
      expect(!signed.ok && signed.error.code).toBe('SIGNER_UNREACHABLE');
      expect(unauthorized.audit.at(-1)).toMatchObject({
        decision: 'failed',
        status: 500,
        address: wallets.solana,
      });
    }, 60_000);
  });
});
