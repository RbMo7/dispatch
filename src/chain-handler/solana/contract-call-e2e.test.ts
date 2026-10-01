import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { fromTransactionInstruction } from './instruction-codec.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

// SPL Memo v2 — a real, stable, well-known program deployed identically on
// every cluster including devnet. Used purely as a real "someone else's
// program" stand-in: CONTEXT.md's Call entry explicitly includes "a
// beneficiary's own application-defined contract call" as something this
// engine must pass through untouched, without assuming any particular
// account count or data shape.
const MEMO_PROGRAM_ID = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');

describe('SolanaChainHandler arbitrary contract call (real devnet)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('validates, signs, and broadcasts a real call to a program that is neither System nor Token, with zero accounts', async () => {
    const sender = await getFundedSenderKeypair();
    signer = await startTestSigner([sender]);
    const connection = getDevnetConnection();

    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url, signer.token),
      senderAddress: sender.publicKey.toBase58(),
    });

    const memoText = `dispatchxyz contract-call test ${Date.now()}`;
    const call = fromTransactionInstruction(
      new TransactionInstruction({
        programId: MEMO_PROGRAM_ID,
        keys: [],
        data: Buffer.from(memoText, 'utf8'),
      }),
    );

    // Before this fix, a call shaped like this (not 2 accounts, not the
    // Token program) was wrongly rejected by validateCall regardless of
    // being perfectly valid.
    const validation = await handler.validateCall(call);
    expect(validation.ok).toBe(true);

    const prepareResult = await handler.prepare([call], sender.publicKey.toBase58());
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

    // Proof this actually ran as a real Memo program call, not just that
    // *some* transaction landed: the memo text is in the on-chain logs.
    const tx = await connection.getTransaction(broadcastResult.value.hash, {
      maxSupportedTransactionVersion: 0,
    });
    const logs = tx?.meta?.logMessages ?? [];
    expect(logs.some((line) => line.includes(memoText))).toBe(true);
  }, 30_000);

  it('rejects a call whose program id is malformed with a structured error, without ever reaching broadcast', async () => {
    const sender = await getFundedSenderKeypair();
    signer = await startTestSigner([sender]);

    const handler = new SolanaChainHandler({
      connection: getDevnetConnection(),
      signerClient: new SignerClient(signer.url, signer.token),
      senderAddress: sender.publicKey.toBase58(),
    });

    const result = await handler.validateCall({
      programId: 'not-a-real-program-id',
      accounts: [],
      data: '',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });
});
