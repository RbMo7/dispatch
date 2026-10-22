import { createHash } from 'node:crypto';

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

// ---- executing and closing (#75) ---------------------------------------------------------------

/** `vaultTransactionExecute` and `vaultTransactionAccountsClose` (spike #70). */
const VAULT_TRANSACTION_EXECUTE = Buffer.from('c208a15799a419ab', 'hex');
const VAULT_TRANSACTION_ACCOUNTS_CLOSE = Buffer.from('c447bbb00223aaa5', 'hex');

/** Anchor's account discriminator for `VaultTransaction`: sha256("account:VaultTransaction")[..8]. */
export const VAULT_TRANSACTION_DISCRIMINATOR = createHash('sha256')
  .update('account:VaultTransaction')
  .digest()
  .subarray(0, 8);

/** What the on-chain `VaultTransaction` account holds that an execution needs. */
export type VaultTransactionAccount = {
  multisig: string;
  index: bigint;
  vaultIndex: number;
  ephemeralSignerBumps: number[];
  message: {
    numSigners: number;
    numWritableSigners: number;
    numWritableNonSigners: number;
    accountKeys: PublicKey[];
    instructions: { programIdIndex: number; accountIndexes: number[]; data: Buffer }[];
    /** How many address-table lookups the message uses. The engine never creates any (a bundle has at most 12 transfers). */
    addressTableLookupCount: number;
  };
};

/**
 * Decodes the `VaultTransaction` account. The account stores the message as
 * plain Borsh with u32 lengths: not the compact form of the create
 * instruction (spike #70, "Correction"). Layout: discriminator, multisig,
 * creator, index u64, bump, vaultIndex, vaultBump, ephemeralSignerBumps
 * (u32 length), then the message: three u8 counts, the account keys, the
 * instructions (program index u8, account indexes and data each with a u32
 * length) and the address-table lookups (a u32 count, then entries). Throws
 * on bytes that are not a VaultTransaction.
 */
export function decodeVaultTransactionAccount(data: Uint8Array): VaultTransactionAccount {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(VAULT_TRANSACTION_DISCRIMINATOR)) {
    throw new Error('the account data is not a Squads VaultTransaction (wrong discriminator)');
  }
  let at = 8;
  const need = (n: number) => {
    if (n < 0 || at + n > bytes.length) {
      throw new Error('the VaultTransaction account data is truncated');
    }
  };
  const u32 = (): number => {
    need(4);
    const value = bytes.readUInt32LE(at);
    at += 4;
    return value;
  };
  const key = (): PublicKey => {
    need(32);
    const value = new PublicKey(bytes.subarray(at, at + 32));
    at += 32;
    return value;
  };

  const multisig = key().toBase58();
  key(); // creator
  need(8 + 3);
  const index = bytes.readBigUInt64LE(at);
  const vaultIndex = bytes[at + 9]!;
  at += 8 + 3; // index, bump, vaultIndex, vaultBump
  const bumpCount = u32();
  need(bumpCount);
  const ephemeralSignerBumps = [...bytes.subarray(at, at + bumpCount)];
  at += bumpCount;

  need(3);
  const numSigners = bytes[at]!;
  const numWritableSigners = bytes[at + 1]!;
  const numWritableNonSigners = bytes[at + 2]!;
  at += 3;
  const keyCount = u32();
  need(keyCount * 32);
  const accountKeys: PublicKey[] = [];
  for (let i = 0; i < keyCount; i++) accountKeys.push(key());

  const instructionCount = u32();
  const instructions: VaultTransactionAccount['message']['instructions'] = [];
  for (let i = 0; i < instructionCount; i++) {
    need(1);
    const programIdIndex = bytes[at]!;
    at += 1;
    const accountCount = u32();
    need(accountCount);
    const accountIndexes = [...bytes.subarray(at, at + accountCount)];
    at += accountCount;
    const dataLength = u32();
    need(dataLength);
    const instructionData = Buffer.from(bytes.subarray(at, at + dataLength));
    at += dataLength;
    instructions.push({ programIdIndex, accountIndexes, data: instructionData });
  }
  const addressTableLookupCount = u32();

  return {
    multisig,
    index,
    vaultIndex,
    ephemeralSignerBumps,
    message: {
      numSigners,
      numWritableSigners,
      numWritableNonSigners,
      accountKeys,
      instructions,
      addressTableLookupCount,
    },
  };
}

/** Whether the static account at `index` is writable, by the message header (the SDK's `isStaticWritableIndex`). */
function isStaticWritable(message: VaultTransactionAccount['message'], index: number): boolean {
  const numKeys = message.accountKeys.length;
  if (index >= numKeys) return false;
  if (index < message.numWritableSigners) return true;
  if (index >= message.numSigners) {
    return index - message.numSigners < message.numWritableNonSigners;
  }
  return false;
}

/**
 * `vaultTransactionExecute`: no arguments; accounts multisig, proposal (w),
 * transaction, member (signer), then the remaining accounts: every static
 * account key of the inner message, writable as the message says. The vault is
 * the inner message's signer, but it is a PDA that signs through the program,
 * so it is never marked a signer here (the SDK does the same). Throws when the
 * message uses address-table lookups or ephemeral signers: the engine builds
 * neither, and its Solana handler signs legacy transactions only.
 */
export function vaultTransactionExecuteInstruction(input: {
  multisig: PublicKey;
  transactionIndex: bigint;
  member: PublicKey;
  vaultTransaction: VaultTransactionAccount;
  proposal?: PublicKey;
  transaction?: PublicKey;
}): TransactionInstruction {
  const { message, ephemeralSignerBumps } = input.vaultTransaction;
  if (message.addressTableLookupCount > 0 || ephemeralSignerBumps.length > 0) {
    throw new Error(
      'a vault transaction with address-table lookups or ephemeral signers cannot be executed by this engine',
    );
  }
  return new TransactionInstruction({
    programId: SQUADS_PROGRAM_ID,
    keys: [
      { pubkey: input.multisig, isSigner: false, isWritable: false },
      {
        pubkey: input.proposal ?? deriveProposalPda(input.multisig, input.transactionIndex),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: input.transaction ?? deriveTransactionPda(input.multisig, input.transactionIndex),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: input.member, isSigner: true, isWritable: false },
      ...message.accountKeys.map((pubkey, i) => ({
        pubkey,
        isSigner: false,
        isWritable: isStaticWritable(message, i),
      })),
    ],
    data: VAULT_TRANSACTION_EXECUTE,
  });
}

/**
 * `vaultTransactionAccountsClose`: permissionless; accounts multisig,
 * proposal (w), transaction (w), rentCollector (w), system program. Both
 * accounts' rent goes to the multisig's rent collector.
 */
export function vaultTransactionAccountsCloseInstruction(input: {
  multisig: PublicKey;
  transactionIndex: bigint;
  rentCollector: PublicKey;
  proposal?: PublicKey;
  transaction?: PublicKey;
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
      {
        pubkey: input.transaction ?? deriveTransactionPda(input.multisig, input.transactionIndex),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: input.rentCollector, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: VAULT_TRANSACTION_ACCOUNTS_CLOSE,
  });
}
