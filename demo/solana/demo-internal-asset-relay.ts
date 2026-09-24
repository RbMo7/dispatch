/**
 * Demo (not part of the engine's own test suite): proves dispatchxyz's
 * Relay Dispatch handles a genuinely custom, freshly-deployed Solana
 * program it has never seen before — not just SystemProgram/SPL
 * Token/Memo.
 *
 * 1. `internal-asset-program/` is a minimal Anchor program whose balances
 *    live entirely in its own PDA-owned accounts, never touching SPL
 *    Token. Build and deploy it first (see internal-asset-program/README
 *    if present, or: `cd internal-asset-program && yarn install &&
 *    anchor build && anchor deploy`), then run
 *    `internal-asset-program/scripts/init-assets.ts` to create and fund
 *    owner A's and owner B's balance PDAs directly against the program —
 *    entirely outside the engine.
 * 2. This script builds and signs a `transfer_asset` instruction entirely
 *    outside the engine — raw Anchor instruction-discriminator encoding,
 *    no @coral-xyz/anchor SDK involved on this side at all, since the
 *    engine (and any real Relay Dispatch caller) only needs to know the
 *    wire format, never the IDL.
 * 3. The signed bytes are POSTed to a real, in-process dispatchxyz app via
 *    POST /v1/dispatch with mode: "relay", driven through a real
 *    Coordinator and real SolanaChainHandler against real devnet, and
 *    polled to a terminal state via GET /v1/dispatch/:id.
 * 4. The transfer is independently verified by reading the program's own
 *    on-chain account state back — not just the engine's own bookkeeping.
 *
 * Run from the repo root: `node_modules/.bin/tsx demo/solana/demo-internal-asset-relay.ts`
 *
 * Set SOLANA_DEVNET_RPC_URL to your own devnet RPC (recommended — the
 * public endpoint is heavily rate-limited) before running either this or
 * internal-asset-program/scripts/init-assets.ts; both fall back to
 * https://api.devnet.solana.com otherwise.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { buildApp } from '../../src/app.js';
import {
  SOLANA_ABANDONMENT_TIMEOUT_MS,
  SolanaChainHandler,
} from '../../src/chain-handler/solana/solana-chain-handler.js';
import { ChainRegistry } from '../../src/chain-registry/chain-registry.js';
import { Coordinator } from '../../src/coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../../src/repository/in-memory-dispatch-store.js';

const DEVNET_RPC_URL = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey('EcqsVLKPa1uuNG1Rs6tj2t8aGj1bAYgEwJszGHmpbo7x');
const AUTH_TOKEN = 'demo-token';
const CHAIN = 'solana' as const;

function anchorDiscriminator(instructionName: string): Buffer {
  return createHash('sha256').update(`global:${instructionName}`).digest().subarray(0, 8);
}

function loadKeypair(path: string): Keypair {
  const secret = JSON.parse(fs.readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const ownerA = loadKeypair('.devnet-fixtures/sender-keypair.json');
  const ownerB = loadKeypair('demo/solana/internal-asset-program/scripts/owner-b-keypair.json');
  const connection = new Connection(DEVNET_RPC_URL, 'confirmed');

  const [assetA] = PublicKey.findProgramAddressSync(
    [Buffer.from('asset'), ownerA.publicKey.toBuffer()],
    PROGRAM_ID,
  );
  const [assetB] = PublicKey.findProgramAddressSync(
    [Buffer.from('asset'), ownerB.publicKey.toBuffer()],
    PROGRAM_ID,
  );

  const beforeA = await connection.getAccountInfo(assetA);
  const beforeB = await connection.getAccountInfo(assetB);
  if (!beforeA || !beforeB) {
    throw new Error(
      'asset accounts not found — run internal-asset-program/scripts/init-assets.ts first',
    );
  }
  console.log('Before transfer — owner A balance:', beforeA.data.readBigUInt64LE(40).toString());
  console.log('Before transfer — owner B balance:', beforeB.data.readBigUInt64LE(40).toString());

  // --- Step 1: build and sign the call entirely outside the engine ---
  const amount = 150n;
  const amountBytes = Buffer.alloc(8);
  amountBytes.writeBigUInt64LE(amount);
  const data = Buffer.concat([anchorDiscriminator('transfer_asset'), amountBytes]);

  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: assetA, isSigner: false, isWritable: true }, // from
      { pubkey: ownerA.publicKey, isSigner: true, isWritable: false }, // owner
      { pubkey: assetB, isSigner: false, isWritable: true }, // to
      { pubkey: ownerB.publicKey, isSigner: false, isWritable: false }, // to_owner
    ],
    data,
  });

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: ownerA.publicKey, blockhash, lastValidBlockHeight });
  tx.add(ix);
  tx.sign(ownerA);
  const signedTransaction = tx
    .serialize({ requireAllSignatures: true, verifySignatures: false })
    .toString('base64');

  console.log(`\nSigned transfer_asset(${amount}) transaction, entirely outside the engine.`);

  // --- Step 2: hand it to the real engine as a Relay Dispatch ---
  const store = new InMemoryDispatchStore();
  const chainRegistry = await ChainRegistry.load([CHAIN], {
    solana: () =>
      Promise.resolve(
        new SolanaChainHandler({
          connection,
          // signerClient omitted — Relay Dispatch never signs, so this
          // deployment genuinely has no Signer to configure.
          senderAddress: ownerA.publicKey.toBase58(),
        }),
      ),
  });
  const app = buildApp({ store, chainRegistry, authToken: AUTH_TOKEN, defaultRetryPolicy: false });

  const postResponse = await app.inject({
    method: 'POST',
    url: '/v1/dispatch',
    headers: {
      authorization: `Bearer ${AUTH_TOKEN}`,
      'idempotency-key': `internal-asset-demo-${Date.now()}`,
    },
    payload: { chain: CHAIN, mode: 'relay', signedTransaction },
  });
  const postBody = postResponse.json<{ dispatchId: string; status: string }>();
  console.log('POST /v1/dispatch ->', postResponse.statusCode, postBody);
  if (postResponse.statusCode !== 202) {
    throw new Error('engine rejected the relay dispatch submission');
  }

  const coordinator = new Coordinator({
    store,
    chainHandlers: chainRegistry.handlers,
    senderAddresses: new Map([[CHAIN, ownerA.publicKey.toBase58()]]),
    abandonmentTimeoutMs: new Map([[CHAIN, SOLANA_ABANDONMENT_TIMEOUT_MS]]),
  });

  // A real deployment runs this on a timer from a separate worker process,
  // sharing the same (Postgres) store the API server writes to — this
  // script plays both roles itself since there's no worker loop wired up
  // yet (a pre-existing, already-triaged gap unrelated to Relay Dispatch).
  await coordinator.processQueuedRelayDispatches(10);

  const deadline = Date.now() + 30_000;
  type RelayGetBody = {
    dispatchId: string;
    mode: string;
    status: string;
    transactionHash: string | null;
    error: unknown;
  };
  let body: RelayGetBody;
  for (;;) {
    await coordinator.pollPendingTransactions(10);
    const getResponse = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${postBody.dispatchId}`,
      headers: { authorization: `Bearer ${AUTH_TOKEN}` },
    });
    body = getResponse.json<RelayGetBody>();
    if (body.status === 'confirmed' || body.status === 'failed' || body.status === 'abandoned')
      break;
    if (Date.now() > deadline)
      throw new Error('relay dispatch did not reach a terminal state in time');
    await sleep(1_500);
  }

  console.log('\nFinal GET /v1/dispatch/:id ->', body);

  // --- Step 3: independently verify on-chain, via the program's own state ---
  const afterA = await connection.getAccountInfo(assetA);
  const afterB = await connection.getAccountInfo(assetB);
  const balanceA = afterA!.data.readBigUInt64LE(40);
  const balanceB = afterB!.data.readBigUInt64LE(40);
  console.log('\nAfter transfer — owner A balance:', balanceA.toString());
  console.log('After transfer — owner B balance:', balanceB.toString());

  if (body.status !== 'confirmed') throw new Error(`expected confirmed, got ${body.status}`);
  console.log(
    '\n✔ Relay Dispatch correctly executed a call against a novel, custom-deployed program.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
