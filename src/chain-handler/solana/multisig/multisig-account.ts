import { createHash } from 'node:crypto';

import { PublicKey, type Commitment, type Connection } from '@solana/web3.js';

/** Squads v4 permission bits (spike #70). The engine's member holds exactly Initiate + Execute. */
export const PERMISSION_INITIATE = 1;
export const PERMISSION_VOTE = 2;
export const PERMISSION_EXECUTE = 4;

export type MultisigMember = { key: string; permissions: number };

/** The fields of Squads v4's `Multisig` account the engine reads (spike #70). */
export type MultisigAccount = {
  createKey: string;
  configAuthority: string;
  threshold: number;
  /** Seconds a proposal must wait after approval before it can execute. */
  timeLockSeconds: number;
  /** The last created transaction index; the next is this + 1. */
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  /** Where closing a proposal refunds rent; undefined means rent can never be reclaimed. */
  rentCollector: string | undefined;
  members: MultisigMember[];
};

/** Anchor's account discriminator: the first 8 bytes of sha256("account:Multisig"). */
export const MULTISIG_DISCRIMINATOR = createHash('sha256')
  .update('account:Multisig')
  .digest()
  .subarray(0, 8);

/**
 * Decodes a Squads v4 `Multisig` account: 8-byte discriminator, createKey,
 * configAuthority, threshold u16, timeLock u32, transactionIndex u64,
 * staleTransactionIndex u64, rentCollector Option<Pubkey>, bump u8, then
 * members as a u32-length vec of {key, permissions u8}. Anything after the
 * members (the account is allocated with room to grow) is ignored. Throws on
 * bytes that are not a Multisig.
 */
export function decodeMultisigAccount(data: Uint8Array): MultisigAccount {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(MULTISIG_DISCRIMINATOR)) {
    throw new Error('the account data is not a Squads Multisig (wrong discriminator)');
  }
  let at = 8;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error('the Multisig account data is truncated');
  };
  const key = (): string => {
    need(32);
    const value = new PublicKey(bytes.subarray(at, at + 32)).toBase58();
    at += 32;
    return value;
  };

  const createKey = key();
  const configAuthority = key();
  need(2 + 4 + 8 + 8 + 1);
  const threshold = bytes.readUInt16LE(at);
  const timeLockSeconds = bytes.readUInt32LE(at + 2);
  const transactionIndex = bytes.readBigUInt64LE(at + 6);
  const staleTransactionIndex = bytes.readBigUInt64LE(at + 14);
  const hasRentCollector = bytes[at + 22];
  at += 23;
  if (hasRentCollector !== 0 && hasRentCollector !== 1) {
    throw new Error('the Multisig account data is malformed (bad rentCollector tag)');
  }
  const rentCollector = hasRentCollector === 1 ? key() : undefined;
  need(1 + 4);
  at += 1; // bump
  const count = bytes.readUInt32LE(at);
  at += 4;
  const members: MultisigMember[] = [];
  for (let i = 0; i < count; i++) {
    const member = key();
    need(1);
    members.push({ key: member, permissions: bytes[at]! });
    at += 1;
  }

  return {
    createKey,
    configAuthority,
    threshold,
    timeLockSeconds,
    transactionIndex,
    staleTransactionIndex,
    rentCollector,
    members,
  };
}

/** What the startup checks learn about the multisig address, read at one slot. */
export type MultisigOnChainState = {
  /** The slot the read was made at. */
  slot: number;
  /** Undefined when no account exists at the address. */
  account: { owner: string; multisig: MultisigAccount | { undecodable: string } } | undefined;
};

/** One commitment for every read the engine makes of the multisig, so they agree with each other. */
export const MULTISIG_READ_COMMITMENT: Commitment = 'confirmed';

/** Everything `readMultisigState` needs from web3.js, so tests can hand it a fake. */
export type MultisigReadConnection = Pick<Connection, 'getAccountInfoAndContext'>;

export async function readMultisigState(
  connection: MultisigReadConnection,
  address: string,
): Promise<MultisigOnChainState> {
  const { context, value } = await connection.getAccountInfoAndContext(
    new PublicKey(address),
    MULTISIG_READ_COMMITMENT,
  );
  if (value === null) return { slot: context.slot, account: undefined };
  const owner = value.owner.toBase58();
  try {
    return { slot: context.slot, account: { owner, multisig: decodeMultisigAccount(value.data) } };
  } catch (cause) {
    const undecodable = cause instanceof Error ? cause.message : String(cause);
    return { slot: context.slot, account: { owner, multisig: { undecodable } } };
  }
}
