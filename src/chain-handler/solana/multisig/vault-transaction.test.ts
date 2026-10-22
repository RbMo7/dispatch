import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { deriveVaultAddress } from './multisig-config.js';
import {
  compileVaultMessage,
  deriveProposalPda,
  deriveTransactionPda,
  proposalAccountSize,
  proposalCreateInstruction,
  vaultTransactionCreateInstruction,
} from './vault-transaction.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const TOKEN = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * Golden vectors produced by `@sqds/multisig` 2.1.4 (scratch script, not a
 * dependency of this repo) for the inputs below: the SDK's own compact
 * message, `vaultTransactionCreate` and `proposalCreate` for index 7.
 */
const GOLDEN = {
  vault: '5AqyarvEEwCuy891CxFLuQjqH6H8i4hc3d4rpyTcXHci',
  transaction: '57dZyEaYKvfqpSaKKx9VGN1fGh1FpuC5xfdDncon6EQZ',
  proposal: 'G52w84M9KPLzvT1ujaWfcJzvYnP7umnKDDqzJndoAuxD',
  message:
    '010102073df45a132da928de821ca6f4edaaa22a598590026a72febe854e59e5cdc100f70303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040400000000000000000000000000000000000000000000000000000000000000008c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859050505050505050505050505050505050505050505050505050505050505050506ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a902030200010c000200000087d6120000000000040600020205030601000100',
  createData:
    '30fa4ea8d0e2dad3000003010000010102073df45a132da928de821ca6f4edaaa22a598590026a72febe854e59e5cdc100f70303030303030303030303030303030303030303030303030303030303030303040404040404040404040404040404040404040404040404040404040404040400000000000000000000000000000000000000000000000000000000000000008c97258f4e2489f1bb3d1029148e0d830b5a1399daff1084048e7bd8dbe9f859050505050505050505050505050505050505050505050505050505050505050506ddf6e1d765a193d9cbe146ceeb79ac1cb485ed5f5b37913a8cf5857eff00a902030200010c000200000087d612000000000004060002020503060100010000',
  proposalData: 'dc3c49e01e6c4f9f070000000000000000',
};
const MULTISIG = key(1);
const MEMBER = key(2);

function sampleInstructions(vault: PublicKey): TransactionInstruction[] {
  return [
    SystemProgram.transfer({ fromPubkey: vault, toPubkey: key(3), lamports: 1_234_567n }),
    new TransactionInstruction({
      programId: ATA_PROGRAM,
      keys: [
        { pubkey: vault, isSigner: true, isWritable: true },
        { pubkey: key(4), isSigner: false, isWritable: true },
        { pubkey: key(4), isSigner: false, isWritable: false },
        { pubkey: key(5), isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    }),
  ];
}

const metas = (instruction: TransactionInstruction) =>
  instruction.keys.map(
    (k) => `${k.pubkey.toBase58()}:${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`,
  );

describe('vault transaction encoding, against the @sqds/multisig 2.1.4 SDK', () => {
  it('derives the vault, transaction and proposal addresses the SDK does', () => {
    expect(deriveVaultAddress(MULTISIG).toBase58()).toBe(GOLDEN.vault);
    expect(deriveTransactionPda(MULTISIG, 7n).toBase58()).toBe(GOLDEN.transaction);
    expect(deriveProposalPda(MULTISIG, 7n).toBase58()).toBe(GOLDEN.proposal);
  });

  it('compiles the same compact message bytes', () => {
    const { bytes } = compileVaultMessage(
      deriveVaultAddress(MULTISIG),
      sampleInstructions(deriveVaultAddress(MULTISIG)),
    );
    expect(bytes.toString('hex')).toBe(GOLDEN.message);
  });

  it('builds vaultTransactionCreate with the SDK data and account order', () => {
    const { bytes } = compileVaultMessage(
      deriveVaultAddress(MULTISIG),
      sampleInstructions(deriveVaultAddress(MULTISIG)),
    );
    const create = vaultTransactionCreateInstruction({
      multisig: MULTISIG,
      transactionIndex: 7n,
      member: MEMBER,
      vaultIndex: 0,
      message: bytes,
    });
    expect(create.data.toString('hex')).toBe(GOLDEN.createData);
    expect(metas(create)).toEqual([
      `${MULTISIG.toBase58()}:w`,
      `${GOLDEN.transaction}:w`,
      `${MEMBER.toBase58()}:s`,
      `${MEMBER.toBase58()}:sw`,
      '11111111111111111111111111111111:',
    ]);
  });

  it('builds proposalCreate as a non-draft proposal, with the SDK data and account order', () => {
    const create = proposalCreateInstruction({
      multisig: MULTISIG,
      transactionIndex: 7n,
      member: MEMBER,
    });
    expect(create.data.toString('hex')).toBe(GOLDEN.proposalData);
    expect(metas(create)).toEqual([
      `${MULTISIG.toBase58()}:`,
      `${GOLDEN.proposal}:w`,
      `${MEMBER.toBase58()}:s`,
      `${MEMBER.toBase58()}:sw`,
      '11111111111111111111111111111111:',
    ]);
  });
});

describe('account sizes (which set the rent)', () => {
  it('sizes the vault transaction account at 221 bytes for one SOL transfer, as measured on devnet', () => {
    const vault = deriveVaultAddress(MULTISIG);
    const { accountSize } = compileVaultMessage(vault, [
      SystemProgram.transfer({ fromPubkey: vault, toPubkey: key(3), lamports: 1n }),
    ]);
    expect(accountSize).toBe(221);
  });

  it('sizes the proposal account at 454 bytes for four members, as measured on devnet', () => {
    expect(proposalAccountSize(4)).toBe(454);
  });
});
