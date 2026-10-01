import { Keypair } from '@solana/web3.js';
import { afterAll, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  startTestSigner,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/**
 * issue 12 — the actual proof this Chain Handler is done, not a smoke test.
 * 500 real payments against real devnet (ADR-0013), driving bundling
 * (issue 10, via one batched `prepare` call that chunks internally),
 * retry (issue 06, organically — real devnet rate-limiting under this much
 * real traffic is a genuine transient-failure scenario, not a forced one),
 * and error mapping (issue 09, for whatever real failures actually occur)
 * together, the way the reference implementation's own comments describe
 * bugs only surfacing at this scale.
 */
const TOTAL_PAYMENTS = 500;
/** Spends ~0.55 devnet SOL and takes ~4 minutes, so it only runs when asked: RUN_SOLANA_VOLUME=1 (like Base's, ADR-0040). */
const RUN = process.env.RUN_SOLANA_VOLUME === '1';
const AMOUNT_LAMPORTS = 1_000_000n; // comfortably above rent-exemption (issue 05's own lesson), modest against the 5 SOL test wallet

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe.runIf(RUN)('SolanaChainHandler devnet volume (issue 12)', () => {
  let signer: TestSignerHandle | undefined;

  afterAll(async () => {
    await signer?.close();
  });

  it(
    `processes ${TOTAL_PAYMENTS} real payments end to end: bundled, retried under real load, every recipient paid exactly once`,
    async () => {
      const sender = await getFundedSenderKeypair();
      signer = await startTestSigner([sender]);
      const connection = getDevnetConnection();
      const senderAddress = sender.publicKey.toBase58();

      const handler = new SolanaChainHandler({
        connection,
        signerClient: new SignerClient(signer.url, signer.token),
        senderAddress,
      });

      const recipients = Array.from({ length: TOTAL_PAYMENTS }, () => Keypair.generate());

      const calls = [];
      for (const recipient of recipients) {
        const callResult = await handler.paymentToCall({
          recipient: recipient.publicKey.toBase58(),
          asset: 'SOL',
          amount: AMOUNT_LAMPORTS.toString(),
        });
        expect(callResult.ok).toBe(true);
        if (!callResult.ok) return;
        const validation = await handler.validateCall(callResult.value);
        expect(validation.ok).toBe(true);
        calls.push(callResult.value);
      }

      // One batched prepare() call: bundling (issue 10) chunks these 500
      // Calls into groups internally — the Coordinator doesn't do this
      // itself yet (it drives one Call at a time), so this is a direct,
      // deliberate exercise of the chunking path at real volume.
      const prepareResult = await handler.prepare(calls, senderAddress);
      expect(prepareResult.ok).toBe(true);
      if (!prepareResult.ok) return;
      expect(prepareResult.value).toHaveLength(TOTAL_PAYMENTS);

      // Collapse to one representative PreparedTransaction per real chunk
      // (sign/broadcast dedupe internally anyway — see bundling.test.ts —
      // this just avoids hundreds of redundant cache-hit calls at this scale).
      const chunkOrder: string[] = [];
      const representativeByChunk = new Map<string, (typeof prepareResult.value)[number]>();
      for (const prepared of prepareResult.value) {
        if (!representativeByChunk.has(prepared.unsignedTransaction)) {
          chunkOrder.push(prepared.unsignedTransaction);
          representativeByChunk.set(prepared.unsignedTransaction, prepared);
        }
      }
      const expectedChunkCount = Math.ceil(TOTAL_PAYMENTS / 8); // MAX_BUNDLE_SIZE, solana-chain-handler.ts
      expect(chunkOrder.length).toBe(expectedChunkCount);

      const hashes: string[] = [];
      for (const chunkKey of chunkOrder) {
        const representative = representativeByChunk.get(chunkKey);
        if (!representative)
          throw new Error('unreachable: chunkOrder/representativeByChunk mismatch');

        // Real load against a public, rate-limited RPC genuinely produces
        // transient RPC_UNAVAILABLE failures (issue 09) — retried here the
        // way the Coordinator's own next poll cycle eventually would,
        // rather than forcing a synthetic failure.
        let hash: string | undefined;
        for (let attempt = 0; attempt < 6 && !hash; attempt++) {
          if (attempt > 0) await sleep(2_000 * attempt);
          const signResult = await handler.sign(representative, senderAddress);
          if (!signResult.ok) {
            if (signResult.error.code === 'RPC_UNAVAILABLE') continue;
            throw new Error(`sign failed non-transiently: ${JSON.stringify(signResult.error)}`);
          }
          const broadcastResult = await handler.broadcast(signResult.value);
          if (!broadcastResult.ok) {
            if (broadcastResult.error.code === 'RPC_UNAVAILABLE') continue;
            throw new Error(
              `broadcast failed non-transiently: ${JSON.stringify(broadcastResult.error)}`,
            );
          }
          hash = broadcastResult.value.hash;
        }
        expect(hash).toBeDefined();
        if (!hash) return;
        hashes.push(hash);

        await sleep(150); // light pacing to stay well under devnet's public RPC rate limits
      }

      expect(hashes).toHaveLength(expectedChunkCount);

      // Confirm every chunk actually landed, not just that broadcast accepted it.
      for (const hash of hashes) {
        const deadline = Date.now() + 30_000;
        let confirmed = false;
        while (Date.now() < deadline && !confirmed) {
          const status = await handler.getStatus(hash);
          if (status.ok && status.value === 'CONFIRMED') confirmed = true;
          else if (status.ok && status.value === 'FAILED') {
            throw new Error(`chunk transaction ${hash} was reported FAILED`);
          } else {
            await sleep(1_000);
          }
        }
        expect(confirmed).toBe(true);
      }

      // Sample recipients across the whole run (every payment individually
      // via getBalance would be another 500 RPC calls against a
      // rate-limited public endpoint) — first, last, and every 10th in
      // between, to catch a systematic bug anywhere in the run, not just
      // its edges.
      const sampleIndices = new Set<number>([0, TOTAL_PAYMENTS - 1]);
      for (let i = 0; i < TOTAL_PAYMENTS; i += 10) sampleIndices.add(i);

      for (const index of sampleIndices) {
        const recipient = recipients[index];
        if (!recipient) continue;
        const balance = await connection.getBalance(recipient.publicKey);
        expect(balance).toBe(Number(AMOUNT_LAMPORTS));
        await sleep(100);
      }
    },
    15 * 60_000,
  );
});
