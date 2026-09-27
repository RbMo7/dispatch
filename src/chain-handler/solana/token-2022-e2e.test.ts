import {
  ACCOUNT_SIZE,
  createInitializeMint2Instruction,
  createInitializeTransferFeeConfigInstruction,
  ExtensionType,
  getAccount,
  getAssociatedTokenAddressSync,
  getMintLen,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../signer/client.js';
import type { SolanaTokenRegistry } from './known-tokens.js';
import { SolanaChainHandler } from './solana-chain-handler.js';
import {
  getDevnetConnection,
  getFundedSenderKeypair,
  getTestMint,
  getTestMint2022,
  startTestSigner,
  testMintDecimals,
  type TestSignerHandle,
} from './test-support/devnet-fixtures.js';

/** #40, #41 against real devnet (ADR-0013): the SOL a token payout costs, and a Token-2022 payout. */
describe('Solana token accounts: network cost and Token-2022 (#40, #41)', () => {
  let signer: TestSignerHandle | undefined;

  afterEach(async () => {
    await signer?.close();
    signer = undefined;
  });

  it('prices a payment to a new recipient at the base fee plus its token-account rent, and to an existing one at the fee alone', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();
    const mint = await getTestMint();
    const senderAddress = sender.publicKey.toBase58();
    const handler = new SolanaChainHandler({
      connection,
      senderAddress,
      knownTokens: { TEST: { mint: mint.toBase58(), decimals: testMintDecimals() } },
    });
    const payTo = async (recipient: string) => {
      const call = await handler.paymentToCall({ recipient, asset: 'TEST', amount: '1' });
      if (!call.ok) throw new Error('paymentToCall failed');
      const cost = await handler.networkCost([call.value], senderAddress);
      if (!cost.ok) throw new Error(cost.error.message);
      return BigInt(cost.value.amount);
    };

    const rent = BigInt(await connection.getMinimumBalanceForRentExemption(ACCOUNT_SIZE));
    expect(await payTo(Keypair.generate().publicKey.toBase58())).toBe(5_000n + rent);
    expect(await payTo(senderAddress)).toBe(5_000n); // the sender's own token account exists
  }, 60_000);

  it('pays a Token-2022 token to a brand-new recipient, and budgets its larger token account', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();
    const mint = await getTestMint2022();
    const senderAddress = sender.publicKey.toBase58();
    signer = await startTestSigner([sender]);
    const handler = new SolanaChainHandler({
      connection,
      signerClient: new SignerClient(signer.url),
      senderAddress,
      knownTokens: {
        T22: { mint: mint.toBase58(), decimals: testMintDecimals(), tokenProgram: 'token-2022' },
      },
    });
    const recipient = Keypair.generate().publicKey;

    const call = await handler.paymentToCall({
      recipient: recipient.toBase58(),
      asset: 'T22',
      amount: '4200',
    });
    if (!call.ok) throw new Error('paymentToCall failed');
    expect(call.value.programId).toBe(TOKEN_2022_PROGRAM_ID.toBase58());
    const cost = await handler.networkCost([call.value], senderAddress);
    if (!cost.ok) throw new Error(cost.error.message);
    // A Token-2022 account carries the ImmutableOwner extension: bigger than a classic one.
    expect(BigInt(cost.value.amount)).toBe(
      5_000n + BigInt(await connection.getMinimumBalanceForRentExemption(170)),
    );

    const prepared = await handler.prepare([call.value], senderAddress);
    if (!prepared.ok || !prepared.value[0]) throw new Error('prepare failed');
    const signed = await handler.sign(prepared.value[0], senderAddress);
    if (!signed.ok) throw new Error(signed.error.message);
    const broadcast = await handler.broadcast(signed.value);
    expect(broadcast.ok).toBe(true);

    const ata = getAssociatedTokenAddressSync(mint, recipient, false, TOKEN_2022_PROGRAM_ID);
    const account = await getAccount(connection, ata, 'confirmed', TOKEN_2022_PROGRAM_ID);
    expect(account.amount).toBe(4200n);
    const balance = await handler.getBalance(recipient.toBase58(), 'T22');
    expect(balance.ok && balance.value.amount).toBe('4200');
  }, 120_000);

  it('verifies configured tokens against their real mints at startup (mainnet review)', async () => {
    const sender = await getFundedSenderKeypair();
    const connection = getDevnetConnection();
    const classic = (await getTestMint()).toBase58();
    const t22 = (await getTestMint2022()).toBase58();
    const decimals = testMintDecimals();
    const verify = (knownTokens: SolanaTokenRegistry) =>
      new SolanaChainHandler({
        connection,
        senderAddress: sender.publicKey.toBase58(),
        knownTokens,
      }).verifyKnownTokens();

    await expect(
      verify({
        A: { mint: classic, decimals },
        B: { mint: t22, decimals, tokenProgram: 'token-2022' },
      }),
    ).resolves.toBeUndefined();
    await expect(verify({ A: { mint: classic, decimals: decimals + 1 } })).rejects.toThrow(
      /decimals/,
    );
    await expect(verify({ B: { mint: t22, decimals } })).rejects.toThrow(
      /not a classic Token mint/,
    );

    // A Token-2022 mint charging a 1% transfer fee: recipients would get less than paid.
    const feeMint = Keypair.generate();
    const space = getMintLen([ExtensionType.TransferFeeConfig]);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
    const tx = new Transaction({ feePayer: sender.publicKey, blockhash, lastValidBlockHeight }).add(
      SystemProgram.createAccount({
        fromPubkey: sender.publicKey,
        newAccountPubkey: feeMint.publicKey,
        space,
        lamports: await connection.getMinimumBalanceForRentExemption(space),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferFeeConfigInstruction(
        feeMint.publicKey,
        sender.publicKey,
        sender.publicKey,
        100,
        1_000_000n,
        TOKEN_2022_PROGRAM_ID,
      ),
      createInitializeMint2Instruction(
        feeMint.publicKey,
        decimals,
        sender.publicKey,
        null,
        TOKEN_2022_PROGRAM_ID,
      ),
    );
    tx.sign(sender, feeMint);
    const signature = await connection.sendRawTransaction(tx.serialize());
    for (let i = 0; i < 30; i++) {
      const { value } = await connection.getSignatureStatuses([signature]);
      if (
        value[0]?.confirmationStatus === 'confirmed' ||
        value[0]?.confirmationStatus === 'finalized'
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await expect(
      verify({ FEE: { mint: feeMint.publicKey.toBase58(), decimals, tokenProgram: 'token-2022' } }),
    ).rejects.toThrow(/transfer fee/);
  }, 120_000);
});
