import { getAccount, getOrCreateAssociatedTokenAccount } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { deriveAssociatedTokenAddress } from './account-resolution.js';
import { buildSplTransferCall } from './spl-transfer.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  getTestMint,
  startTestSigner,
  testMintDecimals,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/**
 * issue 03's own real-devnet proof — every other end-to-end test in this
 * feature (broadcast/status/retry/abandonment/bundling/volume) exercises
 * only the native-SOL path (issue 02). This is the SPL-token equivalent:
 * a real devnet mint (`getTestMint`), a real sign+broadcast+confirm, and a
 * real recipient token account balance read back afterward — including the
 * idempotent create-ATA step (issue 01) actually running on-chain for a
 * recipient who has never held this token before, which the pure unit
 * tests in spl-transfer.test.ts / instruction-codec.test.ts never broadcast
 * to prove.
 */
const TRANSFER_AMOUNT = 5_000_000n; // raw base units (5 * 10^6, matching the test mint's 6 decimals)

describe('SolanaChainHandler SPL token transfer (real devnet)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('paymentToCall -> validateCall -> prepare -> sign -> broadcast lands a real token transfer to a brand-new ATA', async () => {
    const sender = await getFundedSenderKeypair();
    const mint = await getTestMint();
    const decimals = testMintDecimals();
    const recipient = Keypair.generate(); // never held this token before — exercises the idempotent create-ATA path for real
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress: sender.publicKey.toBase58(),
      knownTokens: { TEST: { mint: mint.toBase58(), decimals } },
    });

    const callResult = await handler.paymentToCall({
      recipient: recipient.publicKey.toBase58(),
      asset: 'TEST',
      amount: TRANSFER_AMOUNT.toString(),
    });
    expect(callResult.ok).toBe(true);
    if (!callResult.ok) return;
    expect(callResult.value.accounts).toHaveLength(5); // source ATA, mint, destination ATA, owner, recipient wallet (instruction-codec.ts)

    const validation = await handler.validateCall(callResult.value);
    expect(validation.ok).toBe(true);

    const prepareResult = await handler.prepare([callResult.value], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    expect(prepared).toBeDefined();
    if (!prepared) return;

    const signResult = await handler.sign(prepared, sender.publicKey.toBase58());
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const broadcastResult = await handler.broadcast(signResult.value);
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) {
      throw new Error(`broadcast failed: ${JSON.stringify(broadcastResult)}`);
    }

    // broadcast() already polled to confirmation itself (HTTP-only) before returning ok.
    const recipientAta = deriveAssociatedTokenAddress(recipient.publicKey, mint);
    const account = await getAccount(connection, recipientAta);
    expect(account.amount).toBe(TRANSFER_AMOUNT);

    const balanceResult = await handler.getBalance(recipient.publicKey.toBase58(), 'TEST');
    expect(balanceResult.ok).toBe(true);
    expect(balanceResult.ok && balanceResult.value.amount).toBe(TRANSFER_AMOUNT.toString());
  }, 30_000);

  it('broadcasts a raw caller-supplied 4-account transferChecked Call as-is, to an ATA that already exists', async () => {
    // No Payment/paymentToCall here at all — a caller who already knows the
    // chain's shape (ADR-0018) submits {programId, accounts, data} directly,
    // with none of paymentToCall's 5th bookkeeping account. prepare() must
    // not alter it (instruction-codec.test.ts proves this locally; this
    // proves the resulting transaction is also genuinely valid on-chain).
    const sender = await getFundedSenderKeypair();
    const mint = await getTestMint();
    const decimals = testMintDecimals();
    const recipient = Keypair.generate();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    // Caller is responsible for the destination existing themselves —
    // create it up front, exactly as a real integrator would for a raw call.
    await getOrCreateAssociatedTokenAccount(connection, sender, mint, recipient.publicKey);

    const rawCallResult = buildSplTransferCall(
      sender.publicKey.toBase58(),
      recipient.publicKey.toBase58(),
      mint.toBase58(),
      decimals,
      TRANSFER_AMOUNT,
    );
    expect(rawCallResult.ok).toBe(true);
    if (!rawCallResult.ok) return;
    const rawCall = { ...rawCallResult.value, accounts: rawCallResult.value.accounts.slice(0, 4) };
    expect(rawCall.accounts).toHaveLength(4);

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress: sender.publicKey.toBase58(),
    });

    const validation = await handler.validateCall(rawCall);
    expect(validation.ok).toBe(true);

    const prepareResult = await handler.prepare([rawCall], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    expect(prepared).toBeDefined();
    if (!prepared) return;

    const signResult = await handler.sign(prepared, sender.publicKey.toBase58());
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const broadcastResult = await handler.broadcast(signResult.value);
    expect(broadcastResult.ok).toBe(true);
    if (!broadcastResult.ok) {
      throw new Error(`broadcast failed: ${JSON.stringify(broadcastResult)}`);
    }

    // broadcast() already polled to confirmation itself (HTTP-only) before returning ok.
    const recipientAta = deriveAssociatedTokenAddress(recipient.publicKey, mint);
    const account = await getAccount(connection, recipientAta);
    expect(account.amount).toBe(TRANSFER_AMOUNT);
  }, 30_000);

  it('rejects a raw caller-supplied transferChecked Call whose destination ATA was never created, with a structured error, not a thrown exception', async () => {
    const sender = await getFundedSenderKeypair();
    const mint = await getTestMint();
    const decimals = testMintDecimals();
    const recipient = Keypair.generate(); // deliberately never given an ATA
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const rawCallResult = buildSplTransferCall(
      sender.publicKey.toBase58(),
      recipient.publicKey.toBase58(),
      mint.toBase58(),
      decimals,
      TRANSFER_AMOUNT,
    );
    expect(rawCallResult.ok).toBe(true);
    if (!rawCallResult.ok) return;
    const rawCall = { ...rawCallResult.value, accounts: rawCallResult.value.accounts.slice(0, 4) };

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress: sender.publicKey.toBase58(),
    });

    const prepareResult = await handler.prepare([rawCall], sender.publicKey.toBase58());
    expect(prepareResult.ok).toBe(true);
    if (!prepareResult.ok) return;
    const prepared = prepareResult.value[0];
    if (!prepared) return;
    const signResult = await handler.sign(prepared, sender.publicKey.toBase58());
    expect(signResult.ok).toBe(true);
    if (!signResult.ok) return;

    const broadcastResult = await handler.broadcast(signResult.value);

    expect(broadcastResult.ok).toBe(false);
    expect(!broadcastResult.ok && typeof broadcastResult.error.code).toBe('string');
  }, 30_000);
});
