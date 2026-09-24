/**
 * Initializes the two demo asset accounts this program's transfer_asset
 * instruction needs to already exist: owner A (funded, gets an initial
 * balance) and owner B (a fresh recipient, starts at zero).
 *
 * Run from this directory: `yarn install && npx tsx scripts/init-assets.ts`
 * (after `anchor build` + `anchor deploy`, so target/idl/internal_asset.json
 * and the on-chain program both exist).
 *
 * Owner A reuses dispatchxyz's own cached, funded devnet test wallet
 * (../../../.devnet-fixtures/sender-keypair.json — gitignored, created the
 * first time any of the engine's own real-devnet tests run) rather than
 * airdropping a fresh one: devnet's faucet is rate-limited, and this avoids
 * needing a second funded wallet just for this demo.
 */
import * as anchor from '@coral-xyz/anchor';
import { Keypair, PublicKey, LAMPORTS_PER_SOL, type Connection, type Transaction } from '@solana/web3.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEVNET_RPC_URL = process.env.SOLANA_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The public devnet RPC (and some third-party providers) don't support the
// `signatureSubscribe` websocket method @solana/web3.js's default
// confirmTransaction relies on — plain HTTP polling instead, the same
// pattern dispatchxyz's own SolanaChainHandler.broadcast uses for the same
// reason.
async function sendAndConfirmHttp(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
): Promise<string> {
  tx.sign(...signers);
  const raw = tx.serialize();
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: false });

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const status = value[0];
    if (status) {
      if (status.err) throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return signature;
      }
    }
    await sleep(1_000);
  }
  throw new Error(`transaction ${signature} did not confirm within 60s`);
}

const ownerAKeypairPath = path.join(__dirname, '../../../../.devnet-fixtures/sender-keypair.json');
const ownerASecret = Uint8Array.from(JSON.parse(fs.readFileSync(ownerAKeypairPath, 'utf8')));
const ownerA = Keypair.fromSecretKey(ownerASecret);

// Owner B: a fresh recipient keypair for this demo, persisted alongside the
// program (gitignored — see .gitignore) so re-running this script or the
// later relay demo can reuse the same one.
const ownerBPath = path.join(__dirname, 'owner-b-keypair.json');
let ownerB: Keypair;
if (fs.existsSync(ownerBPath)) {
  ownerB = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(ownerBPath, 'utf8'))));
} else {
  ownerB = Keypair.generate();
  fs.writeFileSync(ownerBPath, JSON.stringify(Array.from(ownerB.secretKey)));
}

async function main() {
  const connection = new anchor.web3.Connection(DEVNET_RPC_URL, 'confirmed');
  const wallet = new anchor.Wallet(ownerA);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: 'confirmed' });
  anchor.setProvider(provider);

  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../target/idl/internal_asset.json'), 'utf8'),
  );
  const program = new anchor.Program(idl, provider);
  const programId = new PublicKey(idl.address);

  const [assetA] = PublicKey.findProgramAddressSync(
    [Buffer.from('asset'), ownerA.publicKey.toBuffer()],
    programId,
  );
  const [assetB] = PublicKey.findProgramAddressSync(
    [Buffer.from('asset'), ownerB.publicKey.toBuffer()],
    programId,
  );

  console.log('Program ID:', programId.toBase58());
  console.log('Owner A (funded wallet):', ownerA.publicKey.toBase58(), '-> asset PDA', assetA.toBase58());
  console.log('Owner B (recipient):', ownerB.publicKey.toBase58(), '-> asset PDA', assetB.toBase58());

  for (const [label, owner, assetPda, initial] of [
    ['A', ownerA.publicKey, assetA, 1_000] as const,
    ['B', ownerB.publicKey, assetB, 0] as const,
  ]) {
    const existing = await connection.getAccountInfo(assetPda);
    if (existing) {
      console.log(`Asset account for owner ${label} already exists, skipping initialize.`);
      continue;
    }
    const ix = await program.methods
      .initializeAsset(new anchor.BN(initial))
      .accounts({
        assetAccount: assetPda,
        owner,
        payer: ownerA.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .instruction();
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new anchor.web3.Transaction({
      feePayer: ownerA.publicKey,
      blockhash,
      lastValidBlockHeight,
    }).add(ix);
    const sig = await sendAndConfirmHttp(connection, tx, [ownerA]);
    console.log(`Initialized asset account for owner ${label} with balance ${initial}: ${sig}`);
  }

  const balA = await program.account.assetAccount.fetch(assetA);
  const balB = await program.account.assetAccount.fetch(assetB);
  console.log('Owner A balance:', balA.balance.toString());
  console.log('Owner B balance:', balB.balance.toString());

  const solBalance = await connection.getBalance(ownerA.publicKey);
  console.log('Owner A SOL balance:', solBalance / LAMPORTS_PER_SOL);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
