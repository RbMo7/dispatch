import { Keypair, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { toTransactionInstruction } from './instruction-codec.js';
import { buildNativeTransferCall, validateNativeTransferCall } from './native-transfer.js';

describe('buildNativeTransferCall', () => {
  it('builds a SolanaCall targeting SystemProgram with the exact lamports amount encoded', () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();

    const result = buildNativeTransferCall(sender, recipient, 1_500_000n);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.programId).toBe(SystemProgram.programId.toBase58());
    expect(result.value.accounts).toEqual([
      { pubkey: sender, isSigner: true, isWritable: true },
      { pubkey: recipient, isSigner: false, isWritable: true },
    ]);

    // Decoding back to a real instruction is the only reliable way to check
    // the lamports amount actually round-trips through the opaque encoding.
    const instruction = toTransactionInstruction(result.value);
    expect(instruction.data.readBigUInt64LE(4)).toBe(1_500_000n);
  });

  it('rejects a malformed recipient with a structured error, not a thrown exception', () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const result = buildNativeTransferCall(sender, 'not-a-real-address', 1n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });

  it('rejects a malformed sender the same way', () => {
    const recipient = Keypair.generate().publicKey.toBase58();
    const result = buildNativeTransferCall('not-a-real-address', recipient, 1n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });
});

describe('validateNativeTransferCall', () => {
  it('accepts a well-formed call', () => {
    const sender = Keypair.generate().publicKey.toBase58();
    const recipient = Keypair.generate().publicKey.toBase58();
    const built = buildNativeTransferCall(sender, recipient, 1n);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateNativeTransferCall(built.value).ok).toBe(true);
  });

  it('rejects a call with the wrong number of accounts', () => {
    const result = validateNativeTransferCall({
      programId: SystemProgram.programId.toBase58(),
      accounts: [
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true, isWritable: true },
      ],
      data: '',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a call whose destination is not a well-formed address', () => {
    const result = validateNativeTransferCall({
      programId: SystemProgram.programId.toBase58(),
      accounts: [
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true, isWritable: true },
        { pubkey: 'not-an-address', isSigner: false, isWritable: true },
      ],
      data: '',
    });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });
});
