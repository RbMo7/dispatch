import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { buildSigner } from '../../../../signer/src/startup.js';
import { SQUADS_PROGRAM_ID } from '../multisig/multisig-config.js';
import {
  decodeVaultTransactionAccount,
  deriveProposalPda,
  deriveTransactionPda,
  vaultTransactionExecuteInstruction,
} from '../multisig/vault-transaction.js';

/**
 * Helpers for the opt-in live Squads test (RUN_SQUADS=1, issue #78): the
 * throwaway devnet 2-of-3 multisig it runs against, its funding, the
 * Approvers' hand-built votes, a human member's late execution, and an
 * in-process real Signer (`signer/`) holding the engine's member key under
 * the `allowedMultisig` policy. Nothing here is imported by the engine.
 *
 * The multisig itself is created once, outside the repo, with the Squads SDK
 * (never a repo dependency); `SQUADS_E2E_KEYS_DIR` holds `public.json` and
 * the keypair files (never committed).
 */

export const RUN_SQUADS = process.env.RUN_SQUADS === '1';

/** Hard cap on what one run may spend from the shared devnet sender, and the balance that wallet must keep. */
const MAX_SPEND_LAMPORTS = 150_000_000;
const SENDER_FLOOR_LAMPORTS = 5_000_000_000;

/** What each key is topped up to when it runs below half of it. */
const TARGET_MEMBER = 30_000_000;
const TARGET_VAULT = 40_000_000;
const TARGET_VOTER = 3_000_000;
const TARGET_HUMAN = 4_000_000;
/** The vault's token balance (6 decimals): 100 tokens, refilled below 20. */
const TARGET_VAULT_TOKENS = 100_000_000n;

const APPROVE = Buffer.from('9025a488bcd82af8', 'hex');
const REJECT = Buffer.from('f33e869ce66af687', 'hex');

export type SquadsE2eFixture = {
  multisig: PublicKey;
  vault: PublicKey;
  /** The engine's key: Initiate + Execute (mask 5), the multisig's rent collector. */
  member: Keypair;
  /** Voter-only Approvers (mask 2). */
  voters: Keypair[];
  /** A human member with Execute only (mask 4): executes late, after the engine has timed out. */
  human: Keypair;
};

function readKeypair(dir: string, name: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as number[]),
  );
}

export function loadSquadsE2eFixture(dir: string): SquadsE2eFixture {
  const pub = JSON.parse(readFileSync(path.join(dir, 'public.json'), 'utf8')) as {
    multisig: string;
    vault: string;
    member: string;
  };
  const fixture: SquadsE2eFixture = {
    multisig: new PublicKey(pub.multisig),
    vault: new PublicKey(pub.vault),
    member: readKeypair(dir, 'member-keypair.json'),
    voters: [1, 2, 3].map((i) => readKeypair(dir, `voter${i}-keypair.json`)),
    human: readKeypair(dir, 'human-keypair.json'),
  };
  if (fixture.member.publicKey.toBase58() !== pub.member) {
    throw new Error('member-keypair.json does not match public.json');
  }
  return fixture;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Sends a legacy transaction and polls (the devnet RPC has no websocket) until it is confirmed; throws on an on-chain error. */
export async function sendAndConfirm(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: Keypair,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight }).add(
    ...instructions,
  );
  tx.sign(payer, ...extraSigners);
  const signature = await connection.sendRawTransaction(tx.serialize());
  for (let i = 0; i < 60; i++) {
    const status = (await connection.getSignatureStatuses([signature])).value[0];
    if (status?.err) {
      throw new Error(`transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    }
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return signature;
    }
    await sleep(1_000);
  }
  throw new Error(`transaction ${signature} did not confirm within 60s`);
}

/**
 * Tops the fixture's wallets up from the cached devnet sender by plain
 * transfers, never below the sender's own floor and never past this run's cap.
 * Returns the lamports it spent.
 */
export async function topUpSquadsFixture(
  connection: Connection,
  fixture: SquadsE2eFixture,
  funder: Keypair,
  mint: PublicKey,
  mintDecimals: number,
): Promise<number> {
  const startBalance = await connection.getBalance(funder.publicKey, 'confirmed');
  const targets: [PublicKey, number][] = [
    [fixture.member.publicKey, TARGET_MEMBER],
    [fixture.vault, TARGET_VAULT],
    ...fixture.voters.map((v): [PublicKey, number] => [v.publicKey, TARGET_VOTER]),
    [fixture.human.publicKey, TARGET_HUMAN],
  ];
  const instructions: TransactionInstruction[] = [];
  let planned = 0;
  for (const [key, target] of targets) {
    const balance = await connection.getBalance(key, 'confirmed');
    if (balance >= target / 2) continue;
    planned += target - balance;
    instructions.push(
      SystemProgram.transfer({
        fromPubkey: funder.publicKey,
        toPubkey: key,
        lamports: target - balance,
      }),
    );
  }

  const vaultAta = getAssociatedTokenAddressSync(mint, fixture.vault, true);
  const vaultTokens = await tokenBalance(connection, vaultAta);
  const tokenTopUp = vaultTokens < TARGET_VAULT_TOKENS / 5n;
  if (tokenTopUp) {
    // The ATA's rent comes from the funder too.
    planned += 2_100_000;
  }
  if (startBalance - planned < SENDER_FLOOR_LAMPORTS || planned > MAX_SPEND_LAMPORTS) {
    throw new Error(
      `refusing to top up the Squads fixture: it would spend ~${planned} lamports from a sender holding ${startBalance} (floor ${SENDER_FLOOR_LAMPORTS}, cap ${MAX_SPEND_LAMPORTS})`,
    );
  }
  if (instructions.length > 0) await sendAndConfirm(connection, instructions, funder);

  if (tokenTopUp) {
    const funderAta = getAssociatedTokenAddressSync(mint, funder.publicKey);
    await sendAndConfirm(
      connection,
      [
        createAssociatedTokenAccountIdempotentInstruction(
          funder.publicKey,
          vaultAta,
          fixture.vault,
          mint,
        ),
        createTransferCheckedInstruction(
          funderAta,
          mint,
          vaultAta,
          funder.publicKey,
          TARGET_VAULT_TOKENS - vaultTokens,
          mintDecimals,
        ),
      ],
      funder,
    );
  }
  return startBalance - (await connection.getBalance(funder.publicKey, 'confirmed'));
}

export async function tokenBalance(connection: Connection, account: PublicKey): Promise<bigint> {
  try {
    return (await getAccount(connection, account, 'confirmed')).amount;
  } catch {
    return 0n;
  }
}

/** A Voter's hand-built `proposalApprove` or `proposalReject` (args: no memo). Accounts: multisig, member (s, w), proposal (w). */
export function voteInstruction(
  fixture: SquadsE2eFixture,
  member: PublicKey,
  proposal: PublicKey,
  kind: 'approve' | 'reject',
): TransactionInstruction {
  return new TransactionInstruction({
    programId: SQUADS_PROGRAM_ID,
    keys: [
      { pubkey: fixture.multisig, isSigner: false, isWritable: false },
      { pubkey: member, isSigner: true, isWritable: true },
      { pubkey: proposal, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([kind === 'approve' ? APPROVE : REJECT, Buffer.from([0])]),
  });
}

/** Has `voter` cast the vote for the Proposal at `transactionIndex`. */
export async function castVote(
  connection: Connection,
  fixture: SquadsE2eFixture,
  voter: Keypair,
  transactionIndex: number | bigint,
  kind: 'approve' | 'reject',
): Promise<string> {
  const proposal = deriveProposalPda(fixture.multisig, BigInt(transactionIndex));
  return sendAndConfirm(
    connection,
    [voteInstruction(fixture, voter.publicKey, proposal, kind)],
    voter,
  );
}

/**
 * The human member executes the approved vault transaction late. The
 * instruction is the engine's own builder (its layout is already proven live),
 * but the member, the signature and the broadcast are the human's: nothing
 * about the engine takes part.
 */
export async function executeAsHuman(
  connection: Connection,
  fixture: SquadsE2eFixture,
  transactionIndex: number | bigint,
): Promise<string> {
  const index = BigInt(transactionIndex);
  const info = await connection.getAccountInfo(
    deriveTransactionPda(fixture.multisig, index),
    'confirmed',
  );
  if (!info) throw new Error(`vault transaction ${index} does not exist`);
  const execute = vaultTransactionExecuteInstruction({
    multisig: fixture.multisig,
    transactionIndex: index,
    member: fixture.human.publicKey,
    vaultTransaction: decodeVaultTransactionAccount(info.data),
  });
  return sendAndConfirm(
    connection,
    [
      ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      execute,
    ],
    fixture.human,
  );
}

export type SignerAuditLine = {
  address?: string;
  chain?: string;
  transactionId?: string;
  decision: string;
  status: number;
  reason?: string;
};

export type MemberSignerHandle = {
  url: string;
  token: string;
  audit: SignerAuditLine[];
  close: () => Promise<void>;
};

/**
 * The real `signer/` server, in-process, with the keyfile backend holding the
 * engine's member key and the policy `{ allowedMultisig }`, so the Signer
 * polices the engine's real create, execute and close transactions.
 */
export async function startMemberSigner(fixture: SquadsE2eFixture): Promise<MemberSignerHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), 'squads-e2e-signer-'));
  const keyfile = path.join(dir, 'keys.json');
  const config = path.join(dir, 'signer.config.json');
  writeFileSync(
    keyfile,
    JSON.stringify({
      secp256k1: {},
      ed25519: { 'squads-member': Buffer.from(fixture.member.secretKey.slice(0, 32)).toString('hex') },
    }),
    { mode: 0o600 },
  );
  const address = fixture.member.publicKey.toBase58();
  writeFileSync(
    config,
    JSON.stringify({
      [address]: {
        curve: 'ed25519',
        backend: 'keyfile',
        keyRef: 'squads-member',
        policy: { allowedMultisig: fixture.multisig.toBase58() },
      },
    }),
  );
  const token = randomBytes(16).toString('hex');
  const audit: SignerAuditLine[] = [];
  const server = await buildSigner(
    { SIGNER_CONFIG: config, SIGNER_KEYFILE: keyfile, SIGNER_AUTH_TOKEN: token },
    (line) => audit.push(JSON.parse(line) as SignerAuditLine),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    token,
    audit,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
