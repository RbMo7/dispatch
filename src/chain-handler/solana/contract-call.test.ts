import { Keypair, SystemProgram } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { validateGenericCall } from './contract-call.js';

// A real, well-known Solana program (SPL Memo v2, identical across every
// cluster) — used here purely as "some program that is neither System nor
// Token" to prove the generic contract-call path, not for its own sake.
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

describe('validateGenericCall', () => {
  it('accepts a well-formed call with zero accounts (a real Memo-shaped call needs none)', () => {
    const result = validateGenericCall({
      programId: MEMO_PROGRAM_ID,
      accounts: [],
      data: Buffer.from('hello from dispatch engine').toString('base64'),
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a well-formed call with several accounts of arbitrary shape (the engine never assumes a count)', () => {
    const result = validateGenericCall({
      programId: Keypair.generate().publicKey.toBase58(),
      accounts: [
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true, isWritable: false },
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: true },
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: false, isWritable: false },
      ],
      data: 'AAAA',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a malformed program id', () => {
    const result = validateGenericCall({ programId: 'not-a-real-program', accounts: [], data: '' });
    expect(result.ok).toBe(false);
  });

  it('rejects a malformed account pubkey', () => {
    const result = validateGenericCall({
      programId: SystemProgram.programId.toBase58(),
      accounts: [{ pubkey: 'not-a-real-address', isSigner: false, isWritable: false }],
      data: '',
    });
    expect(result.ok).toBe(false);
  });

  it('never mutates the call it is given', () => {
    const call = {
      programId: MEMO_PROGRAM_ID,
      accounts: [
        { pubkey: Keypair.generate().publicKey.toBase58(), isSigner: true, isWritable: false },
      ],
      data: 'AAAA',
    };
    const before = structuredClone(call);
    validateGenericCall(call);
    expect(call).toEqual(before);
  });
});
