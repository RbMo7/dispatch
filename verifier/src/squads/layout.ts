// Hand-written decoders for the Squads v4 accounts the verifier reads
// (layouts from the Squads v4 program and its SDK; see
// .scratch/multisig-and-local-signer/spike-findings.md). No SDK dependency:
// the point of this package is that it trusts nothing the engine ships.
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { RpcError } from '../errors.js';

export const SQUADS_PROGRAM_ID = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

const disc = (name: string) =>
  createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);

class Reader {
  offset = 0;
  constructor(
    private readonly buf: Uint8Array,
    private readonly what: string,
  ) {}
  private need(n: number): void {
    if (this.offset + n > this.buf.length)
      throw new RpcError(
        `${this.what} account data is truncated (cannot read ${n} bytes at ${this.offset})`,
      );
  }
  u8(): number {
    this.need(1);
    return this.buf[this.offset++] as number;
  }
  u16(): number {
    this.need(2);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 2).getUint16(
      0,
      true,
    );
    this.offset += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 4).getUint32(
      0,
      true,
    );
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    this.need(8);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 8).getBigUint64(
      0,
      true,
    );
    this.offset += 8;
    return v;
  }
  i64(): bigint {
    this.need(8);
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 8).getBigInt64(
      0,
      true,
    );
    this.offset += 8;
    return v;
  }
  bytes(n: number): Uint8Array {
    this.need(n);
    const v = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return v;
  }
  key(): string {
    return new PublicKey(this.bytes(32)).toBase58();
  }
  /** A borsh Vec length: u32, and never more than the data left (guards against hostile lengths). */
  len(): number {
    const n = this.u32();
    if (n > this.buf.length - this.offset)
      throw new RpcError(`${this.what} account data has an impossible length (${n})`);
    return n;
  }
  checkDiscriminator(expected: Uint8Array): void {
    const got = this.bytes(8);
    if (Buffer.compare(Buffer.from(got), Buffer.from(expected)) !== 0) {
      throw new RpcError(`account is not a Squads ${this.what} (wrong discriminator)`);
    }
  }
}

export interface MultisigAccount {
  threshold: number;
  timeLockSeconds: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  members: { key: string; permissions: number }[];
}

export function decodeMultisig(data: Uint8Array): MultisigAccount {
  const r = new Reader(data, 'Multisig');
  r.checkDiscriminator(disc('Multisig'));
  r.key(); // createKey
  r.key(); // configAuthority
  const threshold = r.u16();
  const timeLockSeconds = r.u32();
  const transactionIndex = r.u64();
  const staleTransactionIndex = r.u64();
  if (r.u8() === 1) r.key(); // rentCollector
  r.u8(); // bump
  const n = r.len();
  const members = [];
  for (let i = 0; i < n; i++) members.push({ key: r.key(), permissions: r.u8() });
  return { threshold, timeLockSeconds, transactionIndex, staleTransactionIndex, members };
}

export const PROPOSAL_STATUSES = [
  'Draft',
  'Active',
  'Rejected',
  'Approved',
  'Executing',
  'Executed',
  'Cancelled',
] as const;
export type ProposalStatusName = (typeof PROPOSAL_STATUSES)[number];

export interface ProposalAccount {
  multisig: string;
  transactionIndex: bigint;
  status: ProposalStatusName;
  /** Unix seconds when the proposal entered this status (Executing carries none). */
  statusTimestamp: bigint | null;
  approved: string[];
  rejected: string[];
  cancelled: string[];
}

export function decodeProposal(data: Uint8Array): ProposalAccount {
  const r = new Reader(data, 'Proposal');
  r.checkDiscriminator(disc('Proposal'));
  const multisig = r.key();
  const transactionIndex = r.u64();
  const tag = r.u8();
  const status = PROPOSAL_STATUSES[tag];
  if (!status) throw new RpcError(`proposal has an unknown status tag ${tag}`);
  // Every variant except Executing carries an i64 timestamp.
  const statusTimestamp = status === 'Executing' ? null : r.i64();
  r.u8(); // bump
  const vec = () => {
    const n = r.len();
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(r.key());
    return out;
  };
  return {
    multisig,
    transactionIndex,
    status,
    statusTimestamp,
    approved: vec(),
    rejected: vec(),
    cancelled: vec(),
  };
}

export interface CompiledInstruction {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
}

export interface VaultTransactionAccount {
  multisig: string;
  creator: string;
  index: bigint;
  vaultIndex: number;
  ephemeralSigners: number;
  message: {
    accountKeys: string[];
    instructions: CompiledInstruction[];
    lookups: { accountKey: string; writableIndexes: number[]; readonlyIndexes: number[] }[];
  };
}

export function decodeVaultTransaction(data: Uint8Array): VaultTransactionAccount {
  const r = new Reader(data, 'VaultTransaction');
  r.checkDiscriminator(disc('VaultTransaction'));
  const multisig = r.key();
  const creator = r.key();
  const index = r.u64();
  r.u8(); // bump
  const vaultIndex = r.u8();
  r.u8(); // vaultBump
  const ephemeralSigners = r.len();
  r.bytes(ephemeralSigners);
  // The stored message is a Borsh struct: u8 header counts, then u32-length Vecs.
  r.u8(); // numSigners
  r.u8(); // numWritableSigners
  r.u8(); // numWritableNonSigners
  const nKeys = r.len();
  const accountKeys: string[] = [];
  for (let i = 0; i < nKeys; i++) accountKeys.push(r.key());
  const nIx = r.len();
  const instructions: CompiledInstruction[] = [];
  for (let i = 0; i < nIx; i++) {
    const programIdIndex = r.u8();
    const accountIndexes = Array.from(r.bytes(r.len()));
    const ixData = Uint8Array.from(r.bytes(r.len()));
    instructions.push({ programIdIndex, accountIndexes, data: ixData });
  }
  const nLookups = r.len();
  const lookups = [];
  for (let i = 0; i < nLookups; i++) {
    const accountKey = r.key();
    const writableIndexes = Array.from(r.bytes(r.len()));
    const readonlyIndexes = Array.from(r.bytes(r.len()));
    lookups.push({ accountKey, writableIndexes, readonlyIndexes });
  }
  return {
    multisig,
    creator,
    index,
    vaultIndex,
    ephemeralSigners,
    message: { accountKeys, instructions, lookups },
  };
}

// ---- PDAs (seeds from the Squads v4 program) ----

const SEED = Buffer.from('multisig');
const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};

export function transactionPda(
  multisig: string,
  index: bigint,
  programId = SQUADS_PROGRAM_ID,
): string {
  return PublicKey.findProgramAddressSync(
    [SEED, new PublicKey(multisig).toBuffer(), Buffer.from('transaction'), u64le(index)],
    new PublicKey(programId),
  )[0].toBase58();
}

export function vaultPda(
  multisig: string,
  vaultIndex: number,
  programId = SQUADS_PROGRAM_ID,
): string {
  return PublicKey.findProgramAddressSync(
    [SEED, new PublicKey(multisig).toBuffer(), Buffer.from('vault'), Buffer.from([vaultIndex])],
    new PublicKey(programId),
  )[0].toBase58();
}

export function proposalPda(
  multisig: string,
  index: bigint,
  programId = SQUADS_PROGRAM_ID,
): string {
  return PublicKey.findProgramAddressSync(
    [
      SEED,
      new PublicKey(multisig).toBuffer(),
      Buffer.from('transaction'),
      u64le(index),
      Buffer.from('proposal'),
    ],
    new PublicKey(programId),
  )[0].toBase58();
}

/** Address lookup table account: 56-byte header, then 32-byte addresses. */
export function decodeLookupTable(data: Uint8Array): string[] {
  if (data.length < 56 || (data.length - 56) % 32 !== 0)
    throw new RpcError('address lookup table account has an unexpected size');
  const out: string[] = [];
  for (let o = 56; o < data.length; o += 32)
    out.push(new PublicKey(data.subarray(o, o + 32)).toBase58());
  return out;
}
