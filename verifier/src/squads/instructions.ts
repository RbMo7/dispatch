import { PublicKey } from '@solana/web3.js';
import { NATIVE } from '../payments.js';
import { decodeLookupTable, type VaultTransactionAccount } from './layout.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export interface RawAccount {
  owner: string;
  data: Uint8Array;
}

/** What the decoder needs from the chain: account reads, nothing else. */
export type AccountReader = (addresses: string[]) => Promise<(RawAccount | null)[]>;

export interface DecodedTransfer {
  /** Index of the instruction inside the vault transaction (0-based). */
  instruction: number;
  recipient: string;
  asset: string;
  amount: bigint;
  /** Human description of the instruction, for the report. */
  how: string;
}

export interface DecodeResult {
  transfers: DecodedTransfer[];
  /** Instructions that are not a recognised payment, or whose recipient cannot be resolved. Each is a MISMATCH. */
  problems: string[];
  /** Instructions that are recognised and harmless (token-account creation). */
  notes: string[];
}

interface TokenAccountInfo {
  mint: string;
  owner: string;
  program: string;
}

function readTokenAccount(raw: RawAccount | null): TokenAccountInfo | null {
  if (!raw) return null;
  if (raw.owner !== TOKEN_PROGRAM && raw.owner !== TOKEN_2022_PROGRAM) return null;
  if (raw.data.length < 165) return null;
  return {
    mint: new PublicKey(raw.data.subarray(0, 32)).toBase58(),
    owner: new PublicKey(raw.data.subarray(32, 64)).toBase58(),
    program: raw.owner,
  };
}

function u64le(data: Uint8Array, offset: number): bigint {
  return new DataView(data.buffer, data.byteOffset + offset, 8).getBigUint64(0, true);
}

const short = (a: string) => `${a.slice(0, 4)}...${a.slice(-4)}`;

/**
 * Decode every instruction in a vault transaction into payments. Only a System
 * transfer, an SPL Token / Token-2022 `transfer` or `transferChecked`, and the
 * Associated Token Account program's create instructions are recognised;
 * anything else is reported as a problem ("unrecognized instruction").
 */
export async function decodeInstructions(
  vt: VaultTransactionAccount,
  vault: string,
  read: AccountReader,
): Promise<DecodeResult> {
  const result: DecodeResult = { transfers: [], problems: [], notes: [] };
  const keys = [...vt.message.accountKeys];

  // Address lookup tables: writable entries of every table first, then readonly ones.
  if (vt.message.lookups.length > 0) {
    const tables = await read(vt.message.lookups.map((l) => l.accountKey));
    const writable: string[] = [];
    const readonly: string[] = [];
    vt.message.lookups.forEach((l, i) => {
      const table = tables[i];
      if (!table) {
        result.problems.push(
          `address lookup table ${l.accountKey} does not exist: cannot resolve the accounts it provides`,
        );
        return;
      }
      const addresses = decodeLookupTable(table.data);
      for (const wi of l.writableIndexes)
        writable.push(addresses[wi] ?? `<missing lookup entry ${wi}>`);
      for (const ri of l.readonlyIndexes)
        readonly.push(addresses[ri] ?? `<missing lookup entry ${ri}>`);
    });
    keys.push(...writable, ...readonly);
  }

  const key = (i: number) => keys[i];

  // Token accounts created inside the transaction (owner and mint are known from the instruction).
  const created = new Map<string, { owner: string; mint: string }>();
  vt.message.instructions.forEach((ix) => {
    if (key(ix.programIdIndex) !== ATA_PROGRAM) return;
    const accts = ix.accountIndexes.map(key);
    // create / create idempotent: [payer, ata, owner, mint, system, token]
    if (
      (ix.data.length === 0 || ix.data[0] === 0 || ix.data[0] === 1) &&
      accts[1] &&
      accts[2] &&
      accts[3]
    ) {
      created.set(accts[1], { owner: accts[2], mint: accts[3] });
    }
  });

  // Read every SPL destination token account in one go.
  const tokenAccountsToRead = new Set<string>();
  for (const ix of vt.message.instructions) {
    const program = key(ix.programIdIndex);
    if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) continue;
    const accts = ix.accountIndexes.map(key);
    const tag = ix.data[0];
    const dest = tag === 3 ? accts[1] : tag === 12 ? accts[2] : undefined;
    if (dest && !created.has(dest)) tokenAccountsToRead.add(dest);
  }
  const onChain = new Map<string, TokenAccountInfo | null>();
  if (tokenAccountsToRead.size > 0) {
    const list = [...tokenAccountsToRead];
    const raws = await read(list);
    list.forEach((a, i) => onChain.set(a, readTokenAccount(raws[i] ?? null)));
  }

  vt.message.instructions.forEach((ix, n) => {
    const label = `instruction ${n + 1}`;
    const program = key(ix.programIdIndex);
    const accts = ix.accountIndexes.map(key);
    const tag = ix.data[0];

    if (
      program === SYSTEM_PROGRAM &&
      ix.data.length === 12 &&
      new DataView(ix.data.buffer, ix.data.byteOffset, 4).getUint32(0, true) === 2
    ) {
      const [from, to] = accts;
      if (accts.length !== 2 || !from || !to) {
        result.problems.push(
          `${label}: unrecognized instruction (System transfer with unexpected accounts)`,
        );
        return;
      }
      if (from !== vault) {
        result.problems.push(
          `${label}: System transfer is not paid from the vault (${vault}) but from ${from}`,
        );
        return;
      }
      result.transfers.push({
        instruction: n,
        recipient: to,
        asset: NATIVE,
        amount: u64le(ix.data, 4),
        how: 'System transfer',
      });
      return;
    }

    if (
      (program === TOKEN_PROGRAM || program === TOKEN_2022_PROGRAM) &&
      (tag === 3 || tag === 12)
    ) {
      const checked = tag === 12;
      if ((checked && ix.data.length !== 10) || (!checked && ix.data.length !== 9)) {
        result.problems.push(
          `${label}: unrecognized instruction (token transfer with unexpected data length ${ix.data.length})`,
        );
        return;
      }
      const source = accts[0];
      const mintArg = checked ? accts[1] : undefined;
      const dest = checked ? accts[2] : accts[1];
      const authority = checked ? accts[3] : accts[2];
      if (!source || !dest || !authority || (checked && !mintArg)) {
        result.problems.push(
          `${label}: unrecognized instruction (token transfer with missing accounts)`,
        );
        return;
      }
      if (authority !== vault) {
        result.problems.push(
          `${label}: token transfer is authorised by ${authority}, not by the vault (${vault})`,
        );
        return;
      }
      const amount = u64le(ix.data, 1);
      const how = `${program === TOKEN_2022_PROGRAM ? 'Token-2022' : 'SPL Token'} ${checked ? 'transferChecked' : 'transfer'}`;
      const made = created.get(dest);
      const info = made ? { owner: made.owner, mint: made.mint } : onChain.get(dest);
      if (!info) {
        result.problems.push(
          `${label}: destination token account ${dest} cannot be resolved to an owner (it does not exist on chain and is not created in this proposal); ${how} of ${amount} cannot be checked`,
        );
        return;
      }
      if (mintArg && info.mint !== mintArg) {
        result.problems.push(
          `${label}: destination token account ${short(dest)} holds mint ${info.mint}, not the stated mint ${mintArg}`,
        );
        return;
      }
      if (!made) {
        const program2 = (info as TokenAccountInfo).program;
        if (program2 !== program) {
          result.problems.push(
            `${label}: destination token account ${short(dest)} belongs to a different token program than the instruction`,
          );
          return;
        }
      }
      result.transfers.push({
        instruction: n,
        recipient: info.owner,
        asset: info.mint,
        amount,
        how,
      });
      return;
    }

    if (
      program === ATA_PROGRAM &&
      (ix.data.length === 0 || ix.data[0] === 0 || ix.data[0] === 1) &&
      accts.length >= 6
    ) {
      const made = created.get(accts[1] as string);
      result.notes.push(
        `${label}: creates the token account ${short(accts[1] as string)} for ${made?.owner ?? '?'} (mint ${made?.mint ?? '?'}); no funds move`,
      );
      return;
    }

    result.problems.push(
      `${label}: unrecognized instruction (program ${program ?? `index ${ix.programIdIndex}`}, ${ix.data.length} bytes of data)`,
    );
  });

  return result;
}
