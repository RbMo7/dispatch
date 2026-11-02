import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { getAccount, getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import type { SolanaCall } from '../../../domain/call.js';
import type { Proposal } from '../../../domain/proposal.js';
import { ok } from '../../../domain/result.js';
import type { SignerClient } from '../../../signer/client.js';
import { buildNativeTransferCall } from '../native-transfer.js';
import { buildSplTransferCall } from '../spl-transfer.js';
import { SolanaChainHandler } from '../solana-chain-handler.js';
import { DEVNET_RPC_URL } from '../test-support/devnet-fixtures.js';
import fixture from './squads-watch-fixture.json' with { type: 'json' };
import { SQUADS_PROGRAM_ID } from './multisig-config.js';
import { SquadsApproval } from './squads-approval.js';
import { deriveProposalPda, deriveTransactionPda } from './vault-transaction.js';
import { registryFromConfig } from '../../../asset-registry/configured-assets.js';

/**
 * Live (ADR-0013), opt-in: RUN_SQUADS_WATCH=1 and SQUADS_WATCH_KEYS_DIR, a
 * directory holding member-keypair.json and voter1/2/3-keypair.json (never
 * committed) for the throwaway devnet 2-of-3 Squads multisig in
 * squads-watch-fixture.json (rent collector = the member, a test mint held by
 * the vault). It runs the whole path for a small SOL bundle and for a bundle
 * of 12 SPL transfers that each create a token account: propose, two votes,
 * read, execute through prepareExecution and the Solana handler, read the
 * execution back by its hash, close, and check the rent reached the collector.
 */
const RUN = process.env.RUN_SQUADS_WATCH === '1';

const SEED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const APPROVE = Buffer.from('9025a488bcd82af8', 'hex');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function loadKeypair(dir: string, name: string): Keypair {
  return Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as number[]),
  );
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  let last!: T;
  for (let i = 0; i < 40; i++) {
    last = await read();
    if (done(last)) return last;
    await sleep(1_500);
  }
  return last;
}

describe.runIf(RUN)(
  'SquadsApproval watches, executes and closes on a real devnet Squads multisig',
  () => {
    it('runs a SOL bundle and a 12-transfer SPL bundle through propose, vote, execute, read and close', async () => {
      const dir = process.env.SQUADS_WATCH_KEYS_DIR!;
      const member = loadKeypair(dir, 'member-keypair.json');
      const voters = [1, 2, 3].map((i) => loadKeypair(dir, `voter${i}-keypair.json`));
      expect(member.publicKey.toBase58()).toBe(fixture.member);

      const privateKey = createPrivateKey({
        key: Buffer.concat([SEED_PKCS8, member.secretKey.subarray(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      });
      const requests: string[] = [];
      const signerClient = {
        requestSignature: (request: { address: string; unsignedTransaction: string }) => {
          requests.push(request.address);
          return Promise.resolve(
            ok({
              signature: nodeSign(
                null,
                Buffer.from(request.unsignedTransaction, 'base64'),
                privateKey,
              ).toString('base64'),
            }),
          );
        },
      } as unknown as SignerClient;

      const connection = new Connection(DEVNET_RPC_URL, 'confirmed');
      const multisig = new PublicKey(fixture.multisig);
      const mint = new PublicKey(fixture.mint);
      const approval = new SquadsApproval({
        connection,
        signerClient,
        multisig: {
          multisigAddress: fixture.multisig,
          memberAddress: fixture.member,
          vaultAddress: fixture.vault,
        },
        assets: registryFromConfig({ solana: `TEST:${fixture.mint}:${6}` }).forChain('solana'),
        pollIntervalMs: 1_500,
      });
      const handler = new SolanaChainHandler({
        connection,
        signerClient,
        senderAddress: fixture.vault,
        approval,
      });

      const vote = async (voter: Keypair, proposal: PublicKey) => {
        const tx = new Transaction({
          feePayer: voter.publicKey,
          ...(await connection.getLatestBlockhash('confirmed')),
        }).add(
          new TransactionInstruction({
            programId: SQUADS_PROGRAM_ID,
            keys: [
              { pubkey: multisig, isSigner: false, isWritable: false },
              { pubkey: voter.publicKey, isSigner: true, isWritable: true },
              { pubkey: proposal, isSigner: false, isWritable: true },
            ],
            data: Buffer.concat([APPROVE, Buffer.from([0])]),
          }),
        );
        tx.sign(voter);
        const signature = await connection.sendRawTransaction(tx.serialize());
        await eventually(
          () => connection.getSignatureStatuses([signature]).then((r) => r.value[0]),
          (status) =>
            status?.confirmationStatus === 'confirmed' ||
            status?.confirmationStatus === 'finalized',
        );
      };

      const cycle = async (calls: SolanaCall[], label: string) => {
        expect(approval.planBundles(calls)).toEqual(ok([calls.map((_, i) => i)]));
        const built = await approval.buildProposal({ calls, sender: fixture.vault });
        if (!built.ok) throw new Error(`build failed: ${JSON.stringify(built.error)}`);
        const signed = await approval.signProposal(built.value);
        if (!signed.ok) throw new Error(`sign failed: ${JSON.stringify(signed.error)}`);
        expect(await approval.submitProposal(signed.value)).toEqual(ok(undefined));

        const index = BigInt(built.value.sequence!);
        const proposalPda = deriveProposalPda(multisig, index);
        const transactionPda = deriveTransactionPda(multisig, index);
        const row = {
          id: `live-${label}`,
          chainRef: built.value.chainRef,
          proposalRef: built.value.proposalRef,
        } as unknown as Proposal;
        const read = () => approval.readProposal(built.value.chainRef);

        // Active, no votes yet; the engine cannot execute it, and nothing can close it.
        const active = await eventually(read, (r) => r.ok && r.value.status === 'active');
        expect(active).toEqual(
          ok({ status: 'active', approvals: 0, threshold: 2, executable: false }),
        );
        const early = await approval.closeProposal(row);
        expect(!early.ok && early.error.chainDetail).toMatchObject({ reason: 'NOT_CLOSABLE' });
        const tooSoon = await approval.prepareExecution(row);
        expect(tooSoon.ok).toBe(false); // the simulation fails: not approved

        await vote(voters[0]!, proposalPda);
        const half = await eventually(read, (r) => r.ok && r.value.approvals === 1);
        expect(half.ok && [half.value.status, half.value.approvals]).toEqual(['active', 1]);
        await vote(voters[1]!, proposalPda);
        const approved = await eventually(read, (r) => r.ok && r.value.status === 'approved');
        expect(approved).toEqual(
          ok({ status: 'approved', approvals: 2, threshold: 2, executable: true }),
        );

        // Execute, exactly as ApprovalFlow does: prepare, sign as the member, hash, broadcast.
        const prepared = await approval.prepareExecution(row);
        if (!prepared.ok)
          throw new Error(`prepareExecution failed: ${JSON.stringify(prepared.error)}`);
        const executeSigned = await handler.sign(prepared.value, fixture.member);
        if (!executeSigned.ok)
          throw new Error(`execute sign failed: ${JSON.stringify(executeSigned.error)}`);
        const hash = handler.transactionHash(executeSigned.value);
        if (!hash.ok) throw new Error('no hash');
        const sent = await handler.broadcast(executeSigned.value);
        if (!sent.ok) throw new Error(`execute broadcast failed: ${JSON.stringify(sent.error)}`);
        expect(sent.value.hash).toBe(hash.value);
        expect(await handler.getStatus(hash.value)).toEqual(ok('CONFIRMED'));

        const detail = await connection.getTransaction(hash.value, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        const units = detail?.meta?.computeUnitsConsumed;

        console.log(
          `[squads-watch] ${label}: ${calls.length} calls, execute used ${units} compute units`,
        );

        const executed = await eventually(read, (r) => r.ok && r.value.status === 'executed');
        expect(executed).toEqual(
          ok({
            status: 'executed',
            approvals: 2,
            threshold: 2,
            executedHash: hash.value,
            executable: false,
          }),
        );

        // Close: the rent of both accounts reaches the collector (the member), less the close fee.
        const rent =
          ((await connection.getAccountInfo(proposalPda, 'confirmed'))?.lamports ?? 0) +
          ((await connection.getAccountInfo(transactionPda, 'confirmed'))?.lamports ?? 0);
        expect(rent).toBeGreaterThan(0);
        const before = await connection.getBalance(member.publicKey, 'confirmed');
        expect(await approval.closeProposal(row)).toEqual(ok(undefined));
        const gone = await eventually(
          () => connection.getAccountInfo(proposalPda, 'confirmed'),
          (account) => account === null,
        );
        expect(gone).toBeNull();
        expect(await connection.getAccountInfo(transactionPda, 'confirmed')).toBeNull();
        const after = await connection.getBalance(member.publicKey, 'confirmed');
        expect(after - before).toBe(rent - 5_000);

        // Closed accounts are idempotent success, and the history still names the execution.
        expect(await approval.closeProposal(row)).toEqual(ok(undefined));
        const afterClose = await eventually(read, (r) => r.ok && r.value.status === 'executed');
        expect(afterClose.ok && afterClose.value.executedHash).toBe(hash.value);
        return { hash: hash.value, units };
      };

      // 1. A small SOL bundle.
      const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
      const solCalls = recipients.map((to) => {
        const call = buildNativeTransferCall(fixture.vault, to.toBase58(), 1_234_567n);
        if (!call.ok) throw new Error('bad call');
        return call.value;
      });
      await cycle(solCalls, 'sol-2');
      for (const to of recipients) {
        expect(await connection.getBalance(to, 'confirmed')).toBe(1_234_567);
      }

      // 2. SPL transfers to wallets with no token account: each creates one. Twelve do not fit one
      // proposal (the create transaction passes 1232 bytes), so the first bundle the planner allows is run.
      const everyWallet = Array.from({ length: 12 }, () => Keypair.generate().publicKey);
      const everyCall = everyWallet.map((to) => {
        const call = buildSplTransferCall(
          fixture.vault,
          to.toBase58(),
          fixture.mint,
          6,
          3n,
          TOKEN_PROGRAM_ID,
        );
        if (!call.ok) throw new Error('bad call');
        return call.value;
      });
      const plan = approval.planBundles(everyCall);
      if (!plan.ok) throw new Error('plan failed');

      console.log(
        `[squads-watch] 12 SPL transfers with token-account creation plan as ${JSON.stringify(plan.value.map((b) => b.length))}`,
      );
      const first = plan.value[0]!;
      const wallets = first.map((i) => everyWallet[i]!);
      await cycle(
        first.map((i) => everyCall[i]!),
        `spl-${first.length}-with-ata-creation`,
      );
      for (const to of wallets) {
        const account = await getAccount(
          connection,
          getAssociatedTokenAddressSync(mint, to),
          'confirmed',
        );
        expect(account.amount).toBe(3n);
      }
      expect(new Set(requests)).toEqual(new Set([fixture.member]));
    }, 600_000);
  },
);
