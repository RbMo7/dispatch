import { Keypair } from '@solana/web3.js';
import { afterAll } from 'vitest';

import { runChainHandlerConformanceSuite } from '../conformance.js';
import { SignerClient } from '../../signer/client.js';
import { buildNativeTransferCall } from './native-transfer.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import { getDevnetConnection, getFundedSenderKeypair, startTestSigner } from './test-support/devnet-fixtures.js';

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

const validCallResult = buildNativeTransferCall(senderAddress, Keypair.generate().publicKey.toBase58(), 2_000_000n);
if (!validCallResult.ok) throw new Error('failed to build the conformance suite fixture Call');

runChainHandlerConformanceSuite(
  'solana',
  () => new SolanaChainHandler({ connection, signerClient: new SignerClient(signer.url), senderAddress }),
  {
    senderAddress,
    asset: 'SOL',
    validPayment: { recipient: Keypair.generate().publicKey.toBase58(), asset: 'SOL', amount: '2000000' },
    validCall: validCallResult.value,
    invalidCall: {
      programId: validCallResult.value.programId,
      accounts: [{ pubkey: 'not-a-real-address', isSigner: true, isWritable: true }],
      data: validCallResult.value.data,
    },
    invalidSignedTransaction: 'not-real-signed-bytes',
  },
);

afterAll(() => signer.close());
