import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { ok } from '../../../domain/result.js';
import type { SignerClient } from '../../../signer/client.js';
import { buildNativeTransferCall } from '../native-transfer.js';
import { DEVNET_RPC_URL } from '../test-support/devnet-fixtures.js';
import fixture from './squads-propose-fixture.json' with { type: 'json' };
import { decodeMultisigAccount } from './multisig-account.js';
import { SquadsApproval } from './squads-approval.js';
import { deriveProposalPda, deriveTransactionPda } from './vault-transaction.js';

/**
 * Live (ADR-0013), opt-in: RUN_SQUADS_PROPOSE=1 and SQUADS_PROPOSE_MEMBER_KEYPAIR
 * (a keypair file; never committed) for the throwaway devnet 2-of-3 Squads
 * multisig in squads-propose-fixture.json, whose member (Initiate + Execute)
 * needs about 0.01 devnet SOL. It proposes a small SOL bundle through
 * SquadsApproval with an in-process Signer and checks what landed on chain.
 */
const RUN = process.env.RUN_SQUADS_PROPOSE === '1';

describe.runIf(RUN)('SquadsApproval proposes on a real devnet Squads multisig', () => {
  it('lands an Active proposal whose vault transaction pays exactly the Calls', async () => {
    const member = Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(readFileSync(process.env.SQUADS_PROPOSE_MEMBER_KEYPAIR!, 'utf8')) as number[],
      ),
    );
    expect(member.publicKey.toBase58()).toBe(fixture.member);
    const privateKey = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        member.secretKey.subarray(0, 32),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    const signerClient = {
      requestSignature: (request: { unsignedTransaction: string }) =>
        Promise.resolve(
          ok({
            signature: nodeSign(
              null,
              Buffer.from(request.unsignedTransaction, 'base64'),
              privateKey,
            ).toString('base64'),
          }),
        ),
    } as unknown as SignerClient;

    const connection = new Connection(DEVNET_RPC_URL, 'confirmed');
    const approval = new SquadsApproval({
      connection,
      signerClient,
      multisig: {
        multisigAddress: fixture.multisig,
        memberAddress: fixture.member,
        vaultAddress: fixture.vault,
      },
    });

    const recipients = [Keypair.generate().publicKey, Keypair.generate().publicKey];
    const amounts = [1_234_567n, 2_345_678n];
    const calls = recipients.map((to, i) => {
      const call = buildNativeTransferCall(fixture.vault, to.toBase58(), amounts[i]!);
      if (!call.ok) throw new Error('bad call');
      return call.value;
    });

    const plan = approval.planBundles(calls);
    expect(plan).toEqual(ok([[0, 1]]));

    const cost = await approval.estimateApprovalCost(calls, fixture.vault);
    expect(cost.ok).toBe(true);

    const built = await approval.buildProposal({ calls, sender: fixture.vault });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const signed = await approval.signProposal(built.value);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const before = await connection.getBalance(member.publicKey);
    const submitted = await approval.submitProposal(signed.value);
    expect(submitted).toEqual(ok(undefined));
    // Idempotent: sending the same bytes again is still success.
    expect(await approval.submitProposal(signed.value)).toEqual(ok(undefined));

    const index = BigInt(built.value.sequence!);
    const multisig = new PublicKey(fixture.multisig);
    const proposalPda = deriveProposalPda(multisig, index);
    expect(proposalPda.toBase58()).toBe(built.value.proposalRef);

    // The proposal exists and is Active: status tag 1 at offset 48 (spike #70).
    const proposal = await connection.getAccountInfo(proposalPda, 'confirmed');
    expect(proposal?.owner.toBase58()).toBe(fixture.owner);
    expect(proposal?.data[48]).toBe(1);
    expect(proposal?.data.readBigUInt64LE(40)).toBe(index);

    // The vault transaction decodes to the two transfers from the vault.
    const vaultTransaction = await connection.getAccountInfo(
      deriveTransactionPda(multisig, index),
      'confirmed',
    );
    expect(vaultTransaction).not.toBeNull();
    const data = vaultTransaction!.data;
    for (const [i, to] of recipients.entries()) {
      const transfer = Buffer.concat([
        Buffer.from([2, 0, 0, 0]),
        Buffer.from(new BigUint64Array([amounts[i]!]).buffer),
      ]);
      expect(data.includes(transfer)).toBe(true);
      expect(data.includes(to.toBuffer())).toBe(true);
    }
    expect(data.includes(new PublicKey(fixture.vault).toBuffer())).toBe(true);
    expect(data.includes(SystemProgram.programId.toBuffer())).toBe(true);
    // Rent was sized from the real account: its length is what the quote assumed.
    expect(vaultTransaction!.lamports).toBe(
      await connection.getMinimumBalanceForRentExemption(data.length),
    );

    // The multisig's last index moved to this proposal's.
    const account = await connection.getAccountInfo(multisig, 'confirmed');
    expect(decodeMultisigAccount(account!.data).transactionIndex).toBe(index);

    // The member paid the fee and both rents, and the committed estimate covers it.
    const spent = BigInt(before) - BigInt(await connection.getBalance(member.publicKey));
    expect(spent).toBeLessThanOrEqual(
      BigInt(built.value.committed.proposer[0]!.amount) + BigInt(LAMPORTS_PER_SOL) / 1000n,
    );
    expect(built.value.expected).toEqual({
      recipients: 2,
      totals: [{ asset: 'SOL', amount: '3580245' }],
    });
  }, 120_000);
});
