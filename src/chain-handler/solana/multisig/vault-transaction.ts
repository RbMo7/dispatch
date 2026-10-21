import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type Message,
} from '@solana/web3.js';
import bs58 from 'bs58';

import { SQUADS_PROGRAM_ID } from './multisig-config.js';

/**
 * The Squads v4 instructions the engine's member key sends to propose, and
 * the vault-transaction message they carry, hand-built so there is no runtime
 * dependency on `@sqds/multisig`. Every layout here is checked byte for byte
 * against that SDK (2.1.4) in `vault-transaction.test.ts`, and against real
 * devnet by `squads-propose-e2e.test.ts` (spike #70, `spike-findings.md`).
 */

/** Anchor discriminators (sha256("global:<name>")[..8]). */
const VAULT_TRANSACTION_CREATE = Buffer.from('30fa4ea8d0e2dad3', 'hex');
const PROPOSAL_CREATE = Buffer.from('dc3c49e01e6c4f9f', 'hex');

const u64le = (value: bigint): Buffer => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(value);
  return out;
};

/** `["multisig", multisig, "transaction", u64le index]`. */
export function deriveTransactionPda(multisig: PublicKey, index: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('multisig'), multisig.toBytes(), Buffer.from('transaction'), u64le(index)],
    SQUADS_PROGRAM_ID,
  )[0];
}

/** `["multisig", multisig, "transaction", u64le index, "proposal"]`. */
export function deriveProposalPda(multisig: PublicKey, index: bigint): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from('multisig'),
      multisig.toBytes(),
      Buffer.from('transaction'),
      u64le(index),
      Buffer.from('proposal'),
    ],
    SQUADS_PROGRAM_ID,
  )[0];
}

/** What the Squads program stores for a vault transaction, from its message: the rent-sizing input, and the bytes to send. */
export type VaultMessage = {
  /** The Squads compact message (`transactionMessageToMultisigTransactionMessageBytes`). */
  bytes: Buffer;
  /** The on-chain `VaultTransaction` account's size in bytes, which sets its rent. */
  accountSize: number;
};

/**
 * The vault transaction message for `instructions`, the vault being the one
 * signer and the payer: `num_signers`, `num_writable_signers`,
 * `num_writable_non_signers`, the account keys (u8 length), the instructions
 * (program index, account indexes with a u8 length, data with a u16 length)
 * and no address-table lookups. Throws when the instructions cannot be
 * compiled or do not fit the format's one-byte counts.
 */
export function compileVaultMessage(
  vault: PublicKey,
  instructions: TransactionInstruction[],
): VaultMessage {
  const message: Message = new Transaction({
    feePayer: vault,
    blockhash: PublicKey.default.toBase58(), // the compact message carries none
    lastValidBlockHeight: 0,
  })
    .add(...instructions)
    .compileMessage();

  const keys = message.accountKeys;
  const { numRequiredSignatures, numReadonlySignedAccounts, numReadonlyUnsignedAccounts } =
    message.header;
  if (keys.length > 255 || message.instructions.length > 255) {
    throw new Error('a vault transaction message holds at most 255 accounts and 255 instructions');
  }

  const parts: Buffer[] = [
    Buffer.from([
      numRequiredSignatures,
      numRequiredSignatures - numReadonlySignedAccounts,
      keys.length - numRequiredSignatures - numReadonlyUnsignedAccounts,
      keys.length,
    ]),
    ...keys.map((key) => key.toBuffer()),
    Buffer.from([message.instructions.length]),
  ];

  // The account stores the same message expanded with u32 lengths (borsh): 3 header bytes,
  // keys, instructions, address-table lookups (a bare u32 count).
  let accountMessageSize = 3 + 4 + 32 * keys.length + 4 + 4;
  for (const instruction of message.instructions) {
    const data = Buffer.from(bs58.decode(instruction.data));
    if (instruction.accounts.length > 255 || data.length > 0xffff) {
      throw new Error('an instruction is too large for a vault transaction message');
    }
    const dataLength = Buffer.alloc(2);
    dataLength.writeUInt16LE(data.length);
    parts.push(
      Buffer.from([instruction.programIdIndex, instruction.accounts.length]),
      Buffer.from(instruction.accounts),
      dataLength,
      data,
    );
    accountMessageSize += 1 + 4 + instruction.accounts.length + 4 + data.length;
  }
  parts.push(Buffer.from([0])); // no address-table lookups

  // 8 discriminator + multisig + creator + index + bump + vault_index + vault_bump
  // + ephemeral_signer_bumps (u32 length, none) + the message.
  const accountSize = 8 + 32 + 32 + 8 + 1 + 1 + 1 + 4 + accountMessageSize;
  return { bytes: Buffer.concat(parts), accountSize };
}

/** The `Proposal` account: 8 + multisig + index + status (tag and i64) + bump + three member vectors. */
export function proposalAccountSize(memberCount: number): number {
  return 58 + 3 * (4 + 32 * memberCount);
}

/**
 * `vaultTransactionCreate` against vault index `vaultIndex`, no ephemeral
 * signers and no memo. The member is both creator and rent payer.
 */
export function vaultTransactionCreateInstruction(input: {
  multisig: PublicKey;
  transactionIndex: bigint;
  member: PublicKey;
  vaultIndex: number;
  message: Buffer;
  /** The transaction account, when the caller already derived it (planning measures sizes, which do not depend on it). */
  transaction?: PublicKey;
}): TransactionInstruction {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(input.message.length);
  return new TransactionInstruction({
    programId: SQUADS_PROGRAM_ID,
    keys: [
      { pubkey: input.multisig, isSigner: false, isWritable: true },
      {
        pubkey: input.transaction ?? deriveTransactionPda(input.multisig, input.transactionIndex),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: input.member, isSigner: true, isWritable: false },
      { pubkey: input.member, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      VAULT_TRANSACTION_CREATE,
      Buffer.from([input.vaultIndex, 0]),
      length,
      input.message,
      Buffer.from([0]), // memo: None
    ]),
  });
}

/** `proposalCreate`, never a draft: the proposal is Active the moment it lands. */
export function proposalCreateInstruction(input: {
  multisig: PublicKey;
  transactionIndex: bigint;
  member: PublicKey;
  /** The proposal account, when the caller already derived it. */
  proposal?: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: SQUADS_PROGRAM_ID,
    keys: [
      { pubkey: input.multisig, isSigner: false, isWritable: false },
      {
        pubkey: input.proposal ?? deriveProposalPda(input.multisig, input.transactionIndex),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: input.member, isSigner: true, isWritable: false },
      { pubkey: input.member, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([PROPOSAL_CREATE, u64le(input.transactionIndex), Buffer.from([0])]),
  });
}
