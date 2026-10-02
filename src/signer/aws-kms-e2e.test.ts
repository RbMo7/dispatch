import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { SignerClient } from './client.js';

/**
 * #50: a key held in AWS KMS, signing through the real Signer (`signer/`,
 * the `aws-kms` backend) for the engine's real Base chain handler, on real
 * Base Sepolia (ADR-0013).
 *
 * It calls AWS and spends testnet funds, so it only runs when asked, with
 * an operator's own KMS key:
 *
 *   RUN_AWS_KMS=1
 *   AWS_KMS_KEY_ID      the key's id, ARN or alias ARN: KeySpec ECC_SECG_P256K1, KeyUsage SIGN_VERIFY
 *   AWS_REGION          and credentials, read by the AWS SDK's own provider chain
 *                       (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN, AWS_PROFILE, ...)
 *
 * The credentials need kms:GetPublicKey and kms:Sign on the key. The key's
 * address needs no funding beforehand: it is topped up from the dev Sender
 * the other live tests use, only when it runs low.
 */
const RUN = process.env.RUN_AWS_KMS === '1';
const SIGNER_TOKEN = randomBytes(16).toString('hex');

const BASE_MIN_BALANCE = parseEther('0.0002');
const BASE_TOP_UP = parseEther('0.0005');

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

describe.runIf(RUN)('an AWS KMS key signing through the real Signer (#50)', () => {
  let sender: Address;
  let client: SignerClient;
  const audit: AuditLine[] = [];
  let close: () => Promise<void>;

  beforeAll(async () => {
    const keyId = requireEnv('AWS_KMS_KEY_ID');
    const kms = createBackends(['aws-kms'], process.env).get('aws-kms');
    if (!kms) throw new Error('the aws-kms backend was not built');
    sender = (await kms.address('secp256k1', keyId)) as Address;

    const config = path.join(
      mkdtempSync(path.join(tmpdir(), 'aws-kms-e2e-')),
      'signer.config.json',
    );
    writeFileSync(
      config,
      JSON.stringify({ [sender]: { curve: 'secp256k1', backend: 'aws-kms', keyRef: keyId } }),
    );
    const server = await buildSigner(
      { ...process.env, SIGNER_CONFIG: config, SIGNER_AUTH_TOKEN: SIGNER_TOKEN },
      (line) => audit.push(JSON.parse(line) as AuditLine),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    client = new SignerClient(`http://127.0.0.1:${port}`, SIGNER_TOKEN);
    close = () => new Promise((resolve) => server.close(() => resolve()));

    await topUpBase(sender);
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
});
