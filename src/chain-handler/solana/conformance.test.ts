import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterAll } from 'vitest';

import { runChainHandlerConformanceSuite } from '../conformance.js';
import { SignerClient } from '../../signer/client.js';
import { buildNativeTransferCall } from './native-transfer.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
} from './test-support/devnet-fixtures.js';

/**
 * issue 11 — the checkpoint proving the extendibility rule (ADR-0015)
 * actually held: this is core-engine-scaffold's own shared suite, unchanged,
 * run against a real Chain Handler. Real devnet throughout (ADR-0013): the
 * signer is a real HTTP service, `prepare`/`sign` hit a real Connection.
 */
const sender = await getFundedSenderKeypair();
const signer = await startTestSigner([sender]);
const connection = getDevnetConnection();
const senderAddress = sender.publicKey.toBase58();

const validCallResult = buildNativeTransferCall(
  senderAddress,
  Keypair.generate().publicKey.toBase58(),
  2_000_000n,
);
if (!validCallResult.ok) throw new Error('failed to build the conformance suite fixture Call');

/**
 * `validateSignedTransaction` is a pure local decode/crypto check
 * (ADR-0032) — this fixture is signed entirely offline, no devnet RPC
 * needed to produce it, only to exercise the rest of this suite.
 */
const validSignedTransactionTx = new Transaction({
  feePayer: sender.publicKey,
  blockhash: Keypair.generate().publicKey.toBase58(),
  lastValidBlockHeight: 1,
});
validSignedTransactionTx.add(
  SystemProgram.transfer({
    fromPubkey: sender.publicKey,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1_000,
  }),
);
validSignedTransactionTx.sign(sender);
const validSignedTransaction = validSignedTransactionTx
  .serialize({ requireAllSignatures: true, verifySignatures: false })
  .toString('base64');

runChainHandlerConformanceSuite(
  'solana',
  () =>
    new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress,
    }),
  {
    senderAddress,
    asset: 'SOL',
    validPayment: {
      recipient: Keypair.generate().publicKey.toBase58(),
      asset: 'SOL',
      amount: '2000000',
    },
    validCall: validCallResult.value,
    invalidCall: {
      programId: validCallResult.value.programId,
      accounts: [{ pubkey: 'not-a-real-address', isSigner: true, isWritable: true }],
      data: validCallResult.value.data,
    },
    validSignedTransaction,
    invalidSignedTransaction: 'not-real-signed-bytes',
    // A real signature over bytes that were never sent anywhere.
    neverBroadcastHash: bs58.encode(validSignedTransactionTx.signature!),
  },
);

afterAll(() => signer.close());
