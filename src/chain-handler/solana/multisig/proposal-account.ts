import { createHash } from 'node:crypto';

import { PublicKey } from '@solana/web3.js';

/** Anchor's account discriminator: the first 8 bytes of sha256("account:Proposal") (`1a5ebdbb74883521`, spike #70). */
export const PROPOSAL_DISCRIMINATOR = createHash('sha256')
  .update('account:Proposal')
  .digest()
  .subarray(0, 8);

/**
 * The `ProposalStatus` variants in on-chain order (their Borsh tag). `executing`
 * is deprecated in Squads v4 and has no timestamp; the engine treats it as unknown.
 */
const STATUS_BY_TAG = [
  'draft',
  'active',
  'rejected',
  'approved',
  'executing',
  'executed',
  'cancelled',
] as const;
export type ProposalStatusKind = (typeof STATUS_BY_TAG)[number];

/** The fields of Squads v4's `Proposal` account the engine reads (spike #70). */
export type ProposalAccount = {
  multisig: string;
  transactionIndex: bigint;
  status: ProposalStatusKind;
  /** Unix seconds at which the status was entered; undefined for `executing`. For `approved` it is what the time lock counts from. */
  statusTimestamp: number | undefined;
  approved: string[];
  rejected: string[];
  cancelled: string[];
};

/**
 * Decodes a Squads v4 `Proposal` account: 8-byte discriminator, multisig,
 * transactionIndex u64, status (a tag byte, then an i64 timestamp for every
 * variant but `executing`), bump u8, then the approved, rejected and
 * cancelled member vectors (u32 length, 32-byte keys). Anything after is
 * ignored. Throws on bytes that are not a Proposal.
 */
export function decodeProposalAccount(data: Uint8Array): ProposalAccount {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(PROPOSAL_DISCRIMINATOR)) {
    throw new Error('the account data is not a Squads Proposal (wrong discriminator)');
  }
  let at = 8;
  const need = (n: number) => {
    if (at + n > bytes.length) throw new Error('the Proposal account data is truncated');
  };
  need(32 + 8 + 1);
  const multisig = new PublicKey(bytes.subarray(at, at + 32)).toBase58();
  const transactionIndex = bytes.readBigUInt64LE(at + 32);
  const tag = bytes[at + 40]!;
  at += 41;
  const status = STATUS_BY_TAG[tag];
  if (status === undefined) throw new Error(`the Proposal has an unknown status tag ${tag}`);
  let statusTimestamp: number | undefined;
  if (status !== 'executing') {
    need(8);
    statusTimestamp = Number(bytes.readBigInt64LE(at));
    at += 8;
  }
  need(1);
  at += 1; // bump

  const keys = (): string[] => {
    need(4);
    const count = bytes.readUInt32LE(at);
    at += 4;
    need(count * 32);
    const out: string[] = [];
    for (let i = 0; i < count; i++, at += 32) {
      out.push(new PublicKey(bytes.subarray(at, at + 32)).toBase58());
    }
    return out;
  };
  const approved = keys();
  const rejected = keys();
  const cancelled = keys();
  return { multisig, transactionIndex, status, statusTimestamp, approved, rejected, cancelled };
}
