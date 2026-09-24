import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { deriveAssociatedTokenAddress } from './account-resolution.js';
import {
  fromTransactionInstruction,
  isNativeTransferCall,
  toTransactionInstruction,
  toTransactionInstructions,
} from './instruction-codec.js';
import { buildNativeTransferCall } from './native-transfer.js';
import { buildSplTransferCall } from './spl-transfer.js';

describe('fromTransactionInstruction / toTransactionInstruction', () => {
  it('round-trips an arbitrary instruction without loss', () => {
    const programId = Keypair.generate().publicKey;
    const a = Keypair.generate().publicKey;
    const instruction = SystemProgram.transfer({
      fromPubkey: a,
      toPubkey: programId,
      lamports: 42n,
    });

    const call = fromTransactionInstruction(instruction);
    const back = toTransactionInstruction(call);

    expect(back.programId.toBase58()).toBe(instruction.programId.toBase58());
    expect(back.data).toEqual(instruction.data);
    expect(back.keys).toEqual(instruction.keys);
  });
});

describe('toTransactionInstructions', () => {
  it('expands a plain native-transfer Call into exactly one instruction', () => {
    const sender = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const built = buildNativeTransferCall(sender.toBase58(), recipient.toBase58(), 1n);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(isNativeTransferCall(built.value)).toBe(true);
    const instructions = toTransactionInstructions(built.value, sender);
    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.programId.toBase58()).toBe(SystemProgram.programId.toBase58());
  });

  it('expands an SPL-transfer Call into [idempotent-create-ATA, transferChecked], dropping the bookkeeping-only 5th account', () => {
    const sender = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const built = buildSplTransferCall(
      sender.toBase58(),
      recipient.toBase58(),
      mint.toBase58(),
      6,
      5n,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const instructions = toTransactionInstructions(built.value, sender);

    expect(instructions).toHaveLength(2);
    expect(instructions[0]!.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    const recipientAta = deriveAssociatedTokenAddress(recipient, mint);
    expect(instructions[0]!.keys.some((k) => k.pubkey.toBase58() === recipientAta.toBase58())).toBe(
      true,
    );

    expect(instructions[1]!.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(instructions[1]!.keys).toHaveLength(4); // the real on-chain minimum, bookkeeping account dropped
  });

  it('does not prepend a create-ATA instruction for a raw 4-account transferChecked Call (caller-supplied, no bookkeeping account)', () => {
    const sender = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;
    const built = buildSplTransferCall(
      sender.toBase58(),
      recipient.toBase58(),
      mint.toBase58(),
      6,
      5n,
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const rawCallerCall = { ...built.value, accounts: built.value.accounts.slice(0, 4) };

    const instructions = toTransactionInstructions(rawCallerCall, sender);

    expect(instructions).toHaveLength(1);
    expect(instructions[0]!.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
  });
});
