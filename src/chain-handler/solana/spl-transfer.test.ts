import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { deriveAssociatedTokenAddress } from './account-resolution.js';
import { buildSplTransferCall, validateSplTransferCall } from './spl-transfer.js';

describe('buildSplTransferCall', () => {
  it('builds a 5-account transferChecked call: source ATA, mint, destination ATA, owner, recipient wallet', () => {
    const sender = Keypair.generate().publicKey;
    const recipient = Keypair.generate().publicKey;
    const mint = Keypair.generate().publicKey;

    const result = buildSplTransferCall(sender.toBase58(), recipient.toBase58(), mint.toBase58(), 6, 10_000_000n);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.programId).toBe(TOKEN_PROGRAM_ID.toBase58());
    expect(result.value.accounts).toHaveLength(5);
    expect(result.value.accounts[0]!.pubkey).toBe(deriveAssociatedTokenAddress(sender, mint).toBase58());
    expect(result.value.accounts[1]!.pubkey).toBe(mint.toBase58());
    expect(result.value.accounts[2]!.pubkey).toBe(deriveAssociatedTokenAddress(recipient, mint).toBase58());
    expect(result.value.accounts[3]).toEqual({ pubkey: sender.toBase58(), isSigner: true, isWritable: false });
    expect(result.value.accounts[4]).toEqual({ pubkey: recipient.toBase58(), isSigner: false, isWritable: false });

    const data = Buffer.from(result.value.data, 'base64');
    expect(data[0]).toBe(12); // TransferChecked discriminant
    expect(data.readBigUInt64LE(1)).toBe(10_000_000n);
    expect(data[9]).toBe(6); // decimals
  });

  it('rejects a malformed mint with a structured error', () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const result = buildSplTransferCall(sender, recipient, 'not-a-mint', 6, 1n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });

  it('rejects a malformed recipient with a structured error', () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const result = buildSplTransferCall(sender, 'not-an-address', mint, 6, 1n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });
});

describe('validateSplTransferCall', () => {
  it('accepts a well-formed 5-account call', () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const mint = Keypair.generate().publicKey.toBase58();
    const built = buildSplTransferCall(sender, recipient, mint, 6, 1n);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateSplTransferCall(built.value).ok).toBe(true);
  });

  it('rejects a call against a different program id', () => {
    const result = validateSplTransferCall({
      programId: Keypair.generate().publicKey.toBase58(),
      accounts: [],
      data: 'AA==',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a call with no instruction data', () => {
    const result = validateSplTransferCall({
      programId: TOKEN_PROGRAM_ID.toBase58(),
      accounts: [
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: false },
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true, isWritable: false },
      ],
      data: '',
    });
    expect(result.ok).toBe(false);
  });
});
