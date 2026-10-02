import { randomBytes } from 'node:crypto';
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
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { SignerClient } from './client.js';

/**
 * #50, #51: keys held in AWS KMS, signing through the real Signer
 * (`signer/`, the `aws-kms` backend) for the engine's real chain handlers,
 * on real Base Sepolia and Solana devnet (ADR-0013).
 *
 * It calls AWS and spends testnet funds, so it only runs when asked, with
 * an operator's own KMS keys:
 *
 *   RUN_AWS_KMS=1
 *   AWS_KMS_KEY_ID          the Base key's id, ARN or alias ARN: KeySpec ECC_SECG_P256K1, KeyUsage SIGN_VERIFY
 *   AWS_KMS_ED25519_KEY_ID  optional, the Solana key: KeySpec ECC_NIST_EDWARDS25519, KeyUsage SIGN_VERIFY;
 *                           the Solana case is skipped without it
 *   AWS_REGION              and credentials, read by the AWS SDK's own provider chain
 *                           (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, AWS_PROFILE, ...)
 *
 * The credentials need kms:GetPublicKey and kms:Sign on the keys. The keys'
 * addresses need no funding beforehand: each is topped up from the dev
 * Senders the other live tests use, only when it runs low.
 */
const RUN = process.env.RUN_AWS_KMS === '1';
const SIGNER_TOKEN = randomBytes(16).toString('hex');

const BASE_MIN_BALANCE = parseEther('0.0002');
const BASE_TOP_UP = parseEther('0.0005');
const ED25519_KEY_ID = process.env.AWS_KMS_ED25519_KEY_ID;
/** Above the rent-exempt minimum, so a fresh recipient account can hold it. */
const SOLANA_AMOUNT = 1_000_000;
/** One transfer, its fee, and the rent-exempt minimum the Sender's own account must keep. */
const SOLANA_MIN_BALANCE = 0.002 * LAMPORTS_PER_SOL;
const SOLANA_TOP_UP = 0.005 * LAMPORTS_PER_SOL;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`RUN_AWS_KMS=1 needs ${name}`);
  return value;
}

type AuditLine = { decision: string; status: number; address?: string };

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

describe.runIf(RUN)('AWS KMS keys signing through the real Signer (#50, #51)', () => {
  let sender: Address;
  let solanaSender: string | undefined;
  let client: SignerClient;
  const audit: AuditLine[] = [];
  let close: () => Promise<void>;

  beforeAll(async () => {
    const keyId = requireEnv('AWS_KMS_KEY_ID');
    const kms = createBackends(['aws-kms'], process.env).get('aws-kms');
    if (!kms) throw new Error('the aws-kms backend was not built');
    sender = (await kms.address('secp256k1', keyId)) as Address;
    solanaSender = ED25519_KEY_ID && (await kms.address('ed25519', ED25519_KEY_ID));

    const config = path.join(
      mkdtempSync(path.join(tmpdir(), 'aws-kms-e2e-')),
      'signer.config.json',
    );
    writeFileSync(
      config,
      JSON.stringify({
        [sender]: { curve: 'secp256k1', backend: 'aws-kms', keyRef: keyId },
        ...(solanaSender && {
          [solanaSender]: { curve: 'ed25519', backend: 'aws-kms', keyRef: ED25519_KEY_ID },
        }),
      }),
    );
    const server = await buildSigner(
      { ...process.env, SIGNER_CONFIG: config, SIGNER_AUTH_TOKEN: SIGNER_TOKEN },
      (line) => audit.push(JSON.parse(line) as AuditLine),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    client = new SignerClient(`http://127.0.0.1:${port}`, SIGNER_TOKEN);
    close = () => new Promise((resolve) => server.close(() => resolve()));

    await Promise.all([
      topUpBase(sender),
      solanaSender && topUpSolana(getDevnetConnection(), solanaSender),
    ]);
  }, DEV_SENDER_LOCK_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await close?.();
  });

  it('lands a Base Sepolia transfer signed by the KMS key', async () => {
    const chain = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender,
      signerClient: client,
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });

    const call = await handler.paymentToCall({
      recipient: privateKeyToAddress(generatePrivateKey()),
      asset: 'ETH',
      amount: '1000',
    });
    if (!call.ok) throw new Error(`paymentToCall failed: ${call.error.message}`);
    const prepared = await handler.prepare([call.value], sender);
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const signed = await handler.sign(prepared.value[0], sender);
    if (!signed.ok) throw new Error(`sign failed: ${signed.error.message}`);
    const broadcast = await handler.broadcast(signed.value);
    if (!broadcast.ok) throw new Error(`broadcast failed: ${broadcast.error.message}`);

    const receipt = await chain.waitForTransactionReceipt({
      hash: broadcast.value.hash as `0x${string}`,
    });
    expect(receipt.status).toBe('success');
    expect(receipt.from.toLowerCase()).toBe(sender.toLowerCase());
    expect(audit.at(-1)).toMatchObject({ decision: 'signed', address: sender });
  }, 120_000);

  it.runIf(Boolean(ED25519_KEY_ID))(
    'lands a Solana devnet transfer signed by the KMS key',
    async () => {
      if (!solanaSender) throw new Error('the Solana key has no address');
      const connection = getDevnetConnection();
      const handler = new SolanaChainHandler({
        connection,
        signerClient: client,
        senderAddress: solanaSender,
      });
      const recipient = Keypair.generate().publicKey;

      const call = await handler.paymentToCall({
        recipient: recipient.toBase58(),
        asset: 'SOL',
        amount: String(SOLANA_AMOUNT),
      });
      if (!call.ok) throw new Error(`paymentToCall failed: ${call.error.message}`);
      const prepared = await handler.prepare([call.value], solanaSender);
      if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
      const signed = await handler.sign(prepared.value[0], solanaSender);
      if (!signed.ok) throw new Error(`sign failed: ${signed.error.message}`);
      const broadcast = await handler.broadcast(signed.value);
      if (!broadcast.ok) throw new Error(`broadcast failed: ${broadcast.error.message}`);

      expect(await connection.getBalance(recipient)).toBe(SOLANA_AMOUNT);
      expect(audit.at(-1)).toMatchObject({ decision: 'signed', address: solanaSender });
    },
    120_000,
  );
});
