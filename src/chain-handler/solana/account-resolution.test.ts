import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  associatedTokenAccountExists,
  deriveAssociatedTokenAddress,
  idempotentCreateAtaInstruction,
} from './account-resolution.js';
import { getDevnetConnection } from './test-support/devnet-fixtures.js';

// Wrapped SOL's mint is identical across every cluster including devnet, so
// this is a real mint we can test derivation/lookup against without needing
// our own funded fixtures (ADR-0013: real RPC, no fake chain behavior).
const WRAPPED_SOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');

describe('deriveAssociatedTokenAddress', () => {
  it('matches the SDK-derived address for the same owner/mint (correct program ids, on-curve owner)', () => {
    const owner = Keypair.generate().publicKey;
    const expected = getAssociatedTokenAddressSync(WRAPPED_SOL_MINT, owner);
    expect(deriveAssociatedTokenAddress(owner, WRAPPED_SOL_MINT).toBase58()).toBe(
      expected.toBase58(),
    );
  });

  it('is deterministic: the same owner/mint always derives the same address', () => {
    const owner = Keypair.generate().publicKey;
    const first = deriveAssociatedTokenAddress(owner, WRAPPED_SOL_MINT);
    const second = deriveAssociatedTokenAddress(owner, WRAPPED_SOL_MINT);
    expect(first.toBase58()).toBe(second.toBase58());
  });

  it('derives a different address for a different owner', () => {
    const a = deriveAssociatedTokenAddress(Keypair.generate().publicKey, WRAPPED_SOL_MINT);
    const b = deriveAssociatedTokenAddress(Keypair.generate().publicKey, WRAPPED_SOL_MINT);
    expect(a.toBase58()).not.toBe(b.toBase58());
  });
});

describe('associatedTokenAccountExists', () => {
  it('reports false for a fresh keypair that has never had an ATA created (real devnet lookup)', async () => {
    const connection = getDevnetConnection();
    const owner = Keypair.generate().publicKey;
    const ata = deriveAssociatedTokenAddress(owner, WRAPPED_SOL_MINT);

    const result = await associatedTokenAccountExists(connection, ata);

    expect(result.ok).toBe(true);
    expect(result.ok && result.value).toBe(false);
  });
});

describe('idempotentCreateAtaInstruction', () => {
  it('targets the associated-token program and the derived ATA as a writable account', () => {
    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const expectedAta = deriveAssociatedTokenAddress(owner, WRAPPED_SOL_MINT);

    const instruction = idempotentCreateAtaInstruction(payer, owner, WRAPPED_SOL_MINT);

    expect(instruction.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    const ataKey = instruction.keys.find((k) => k.pubkey.toBase58() === expectedAta.toBase58());
    expect(ataKey?.isWritable).toBe(true);
  });

  it('never mutates the owner/mint public keys it is given', () => {
    const payer = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const ownerBefore = owner.toBase58();
    const mintBefore = WRAPPED_SOL_MINT.toBase58();

    idempotentCreateAtaInstruction(payer, owner, WRAPPED_SOL_MINT);

    expect(owner.toBase58()).toBe(ownerBefore);
    expect(WRAPPED_SOL_MINT.toBase58()).toBe(mintBefore);
  });
});
