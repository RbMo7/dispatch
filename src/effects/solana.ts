import bs58 from 'bs58';

import type { SolanaCall } from '../domain/call.js';
import type { SolanaEffects, SolanaTokenBalance } from '../domain/effects.js';
import { NATIVE_ADDRESS } from '../domain/known-asset.js';
import {
  amountOf,
  type ArgView,
  type AssetAt,
  type CallView,
  type EffectsView,
  type EventView,
  type TransferStandard,
  type TransferView,
  undecodedSources,
} from './view.js';

export const SYSTEM_PROGRAM = '11111111111111111111111111111111';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const MEMO_PROGRAMS = [
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
];
export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';

type Field = 'u8' | 'u32' | 'u64' | 'pubkey';
/** What an argument amounts to: lamports, or tokens of the mint named by the `mint` account. */
type AmountKind = 'lamports' | 'tokens';

type Instruction = {
  name: string;
  accounts: string[];
  fields: [name: string, field: Field][];
  amount?: { field: string; kind: AmountKind };
};

type Program = {
  decoder: string;
  /** How many leading bytes say which instruction it is. */
  tagBytes: 1 | 4;
  instructions: Record<number, Instruction>;
};

const SYSTEM: Program = {
  decoder: 'system',
  tagBytes: 4,
  instructions: {
    0: {
      name: 'createAccount',
      accounts: ['from', 'newAccount'],
      fields: [
        ['lamports', 'u64'],
        ['space', 'u64'],
        ['owner', 'pubkey'],
      ],
      amount: { field: 'lamports', kind: 'lamports' },
    },
    1: { name: 'assign', accounts: ['account'], fields: [['owner', 'pubkey']] },
    2: {
      name: 'transfer',
      accounts: ['from', 'to'],
      fields: [['lamports', 'u64']],
      amount: { field: 'lamports', kind: 'lamports' },
    },
    4: {
      name: 'advanceNonceAccount',
      accounts: ['nonceAccount', 'recentBlockhashes', 'authority'],
      fields: [],
    },
    8: { name: 'allocate', accounts: ['account'], fields: [['space', 'u64']] },
  },
};

const tokens = (field: string) => ({ field, kind: 'tokens' as const });

/** SPL Token's instructions; Token-2022 keeps the same numbering for these. */
const TOKEN_INSTRUCTIONS: Record<number, Instruction> = {
  0: {
    name: 'initializeMint',
    accounts: ['mint', 'rent'],
    fields: [
      ['decimals', 'u8'],
      ['mintAuthority', 'pubkey'],
    ],
  },
  1: { name: 'initializeAccount', accounts: ['account', 'mint', 'owner', 'rent'], fields: [] },
  3: {
    name: 'transfer',
    accounts: ['source', 'destination', 'authority'],
    fields: [['amount', 'u64']],
    amount: tokens('amount'),
  },
  4: {
    name: 'approve',
    accounts: ['source', 'delegate', 'owner'],
    fields: [['amount', 'u64']],
    amount: tokens('amount'),
  },
  5: { name: 'revoke', accounts: ['source', 'owner'], fields: [] },
  6: { name: 'setAuthority', accounts: ['account', 'currentAuthority'], fields: [] },
  7: {
    name: 'mintTo',
    accounts: ['mint', 'account', 'authority'],
    fields: [['amount', 'u64']],
    amount: tokens('amount'),
  },
  8: {
    name: 'burn',
    accounts: ['account', 'mint', 'authority'],
    fields: [['amount', 'u64']],
    amount: tokens('amount'),
  },
  9: { name: 'closeAccount', accounts: ['account', 'destination', 'authority'], fields: [] },
  10: { name: 'freezeAccount', accounts: ['account', 'mint', 'authority'], fields: [] },
  11: { name: 'thawAccount', accounts: ['account', 'mint', 'authority'], fields: [] },
  12: {
    name: 'transferChecked',
    accounts: ['source', 'mint', 'destination', 'authority'],
    fields: [
      ['amount', 'u64'],
      ['decimals', 'u8'],
    ],
    amount: tokens('amount'),
  },
  13: {
    name: 'approveChecked',
    accounts: ['source', 'mint', 'delegate', 'owner'],
    fields: [
      ['amount', 'u64'],
      ['decimals', 'u8'],
    ],
    amount: tokens('amount'),
  },
  14: {
    name: 'mintToChecked',
    accounts: ['mint', 'account', 'authority'],
    fields: [
      ['amount', 'u64'],
      ['decimals', 'u8'],
    ],
    amount: tokens('amount'),
  },
  15: {
    name: 'burnChecked',
    accounts: ['account', 'mint', 'authority'],
    fields: [
      ['amount', 'u64'],
      ['decimals', 'u8'],
    ],
    amount: tokens('amount'),
  },
  16: {
    name: 'initializeAccount2',
    accounts: ['account', 'mint', 'rent'],
    fields: [['owner', 'pubkey']],
  },
  17: { name: 'syncNative', accounts: ['account'], fields: [] },
  18: { name: 'initializeAccount3', accounts: ['account', 'mint'], fields: [['owner', 'pubkey']] },
  20: {
    name: 'initializeMint2',
    accounts: ['mint'],
    fields: [
      ['decimals', 'u8'],
      ['mintAuthority', 'pubkey'],
    ],
  },
  21: { name: 'getAccountDataSize', accounts: ['mint'], fields: [] },
  22: { name: 'initializeImmutableOwner', accounts: ['account'], fields: [] },
};

const ATA_ACCOUNTS = [
  'payer',
  'associatedAccount',
  'owner',
  'mint',
  'systemProgram',
  'tokenProgram',
];

const PROGRAMS: Record<string, Program> = {
  [SYSTEM_PROGRAM]: SYSTEM,
  [TOKEN_PROGRAM]: { decoder: 'spl-token', tagBytes: 1, instructions: TOKEN_INSTRUCTIONS },
  [TOKEN_2022_PROGRAM]: { decoder: 'token-2022', tagBytes: 1, instructions: TOKEN_INSTRUCTIONS },
  [ASSOCIATED_TOKEN_PROGRAM]: {
    decoder: 'associated-token-account',
    tagBytes: 1,
    instructions: {
      0: { name: 'create', accounts: ATA_ACCOUNTS, fields: [] },
      1: { name: 'createIdempotent', accounts: ATA_ACCOUNTS, fields: [] },
      2: {
        name: 'recoverNested',
        accounts: [
          'nestedAccount',
          'nestedMint',
          'destinationAccount',
          'ownerAccount',
          'ownerMint',
          'wallet',
          'tokenProgram',
        ],
        fields: [],
      },
    },
  },
  [COMPUTE_BUDGET_PROGRAM]: {
    decoder: 'compute-budget',
    tagBytes: 1,
    instructions: {
      1: { name: 'requestHeapFrame', accounts: [], fields: [['bytes', 'u32']] },
      2: { name: 'setComputeUnitLimit', accounts: [], fields: [['units', 'u32']] },
      3: { name: 'setComputeUnitPrice', accounts: [], fields: [['microLamports', 'u64']] },
      4: { name: 'setLoadedAccountsDataSizeLimit', accounts: [], fields: [['bytes', 'u32']] },
    },
  },
};

const FIELD_SIZE: Record<Field, number> = { u8: 1, u32: 4, u64: 8, pubkey: 32 };

function readField(bytes: Buffer, at: number, field: Field): string | undefined {
  if (at + FIELD_SIZE[field] > bytes.length) return undefined;
  switch (field) {
    case 'u8':
      return String(bytes.readUInt8(at));
    case 'u32':
      return String(bytes.readUInt32LE(at));
    case 'u64':
      return bytes.readBigUInt64LE(at).toString();
    case 'pubkey':
      return bs58.encode(bytes.subarray(at, at + 32));
  }
}

/** What the transaction itself says about token accounts: each one's mint and owner. */
type TokenAccounts = ReadonlyMap<string, SolanaTokenBalance>;

const NO_TOKEN_ACCOUNTS: TokenAccounts = new Map();

type Decoded = { view: CallView; instruction?: Instruction; named: Map<string, string> };

/** The first bytes of unknown data, as an Anchor-style 8-byte discriminator at most. */
const discriminator = (bytes: Buffer, length: number) =>
  bytes.subarray(0, Math.min(length, bytes.length)).toString('hex');

function decodeInstruction(
  programId: string,
  accounts: string[],
  data: string,
  assetAt: AssetAt,
  tokenAccounts: TokenAccounts,
): Decoded {
  const bytes = Buffer.from(data, 'base64');
  const named = new Map<string, string>();
  const undecoded = (selectorBytes: number): Decoded => ({
    view: {
      target: programId,
      decoded: false,
      ...(bytes.length > 0 ? { selector: discriminator(bytes, selectorBytes) } : {}),
      data,
    },
    named,
  });

  if (MEMO_PROGRAMS.includes(programId)) {
    return {
      view: {
        target: programId,
        decoded: true,
        decoder: 'memo',
        function: 'memo',
        args: [{ name: 'text', type: 'string', value: bytes.toString('utf8') }],
      },
      named,
    };
  }
  const program = PROGRAMS[programId];
  if (!program) return undecoded(8);
  // The Associated Token Account program's original `create` carries no data at all.
  const tag =
    bytes.length === 0 && programId === ASSOCIATED_TOKEN_PROGRAM
      ? 0
      : bytes.length < program.tagBytes
        ? undefined
        : program.tagBytes === 4
          ? bytes.readUInt32LE(0)
          : bytes.readUInt8(0);
  const instruction = tag === undefined ? undefined : program.instructions[tag];
  if (!instruction || tag === undefined) return undecoded(program.tagBytes);

  const args: ArgView[] = [];
  instruction.accounts.forEach((name, i) => {
    const account = accounts[i];
    if (account === undefined) return;
    named.set(name, account);
    args.push({ name, type: 'pubkey', value: account });
  });
  const mint = named.get('mint') ?? tokenAccounts.get(named.get('source') ?? '')?.mint;
  let at = program.tagBytes;
  for (const [name, field] of instruction.fields) {
    const value = readField(bytes, at, field);
    if (value === undefined) return undecoded(program.tagBytes);
    at += FIELD_SIZE[field];
    named.set(name, value);
    const amount =
      instruction.amount?.field === name
        ? amountOf(
            assetAt,
            'solana',
            instruction.amount.kind === 'lamports' ? NATIVE_ADDRESS : mint,
            value,
          )
        : undefined;
    args.push({
      name,
      type: field,
      value,
      ...(amount?.asset ? { asset: amount.asset, formatted: amount.formatted } : {}),
    });
  }
  return {
    view: {
      target: programId,
      decoded: true,
      decoder: program.decoder,
      function: instruction.name,
      args,
      selector: discriminator(bytes, program.tagBytes),
    },
    instruction,
    named,
  };
}

function tokenAccountsOf(effects: SolanaEffects | undefined): TokenAccounts {
  if (!effects) return NO_TOKEN_ACCOUNTS;
  return new Map(effects.tokenBalances.map((balance) => [balance.account, balance]));
}

/**
 * ADR-0063: a Solana call item, named by the built-in decoders when one knows
 * its program. `effects`, once confirmed, tells which mint a plain token
 * `transfer` moved. Pure.
 */
export function decodeSolanaCall(
  call: SolanaCall,
  assetAt: AssetAt,
  effects?: SolanaEffects,
): CallView {
  return decodeInstruction(
    call.programId,
    call.accounts.map((account) => account.pubkey),
    call.data,
    assetAt,
    tokenAccountsOf(effects),
  ).view;
}

function transferOf(
  programId: string,
  decoded: Decoded,
  tokenAccounts: TokenAccounts,
  assetAt: AssetAt,
): TransferView | null {
  const { instruction, named } = decoded;
  if (!instruction) return null;
  const ownerOf = (account: string | undefined) =>
    account === undefined ? null : (tokenAccounts.get(account)?.owner ?? account);
  if (programId === SYSTEM_PROGRAM && instruction.name === 'transfer') {
    return {
      standard: 'native',
      token: NATIVE_ADDRESS,
      from: named.get('from') ?? null,
      to: named.get('to') ?? null,
      ...amountOf(assetAt, 'solana', NATIVE_ADDRESS, named.get('lamports') ?? '0'),
    };
  }
  const standard: TransferStandard | null =
    programId === TOKEN_PROGRAM ? 'spl' : programId === TOKEN_2022_PROGRAM ? 'token-2022' : null;
  if (!standard) return null;
  const account = named.get('account');
  const sides: Record<
    string,
    [from: string | null, to: string | null, mintOf: string | undefined]
  > = {
    transfer: [
      ownerOf(named.get('source')),
      ownerOf(named.get('destination')),
      named.get('source'),
    ],
    transferChecked: [
      ownerOf(named.get('source')),
      ownerOf(named.get('destination')),
      named.get('source'),
    ],
    mintTo: [null, ownerOf(account), account],
    mintToChecked: [null, ownerOf(account), account],
    burn: [ownerOf(account), null, account],
    burnChecked: [ownerOf(account), null, account],
  };
  const side = sides[instruction.name];
  if (!side) return null;
  const [from, to, holder] = side;
  const mint = named.get('mint') ?? tokenAccounts.get(holder ?? '')?.mint;
  if (!mint) return null;
  return {
    standard,
    token: mint,
    from,
    to,
    ...amountOf(assetAt, 'solana', mint, named.get('amount') ?? '0'),
  };
}

/** ADR-0063: a confirmed Solana transaction's stored effects, decoded. Pure. */
export function decodeSolanaEffects(effects: SolanaEffects, assetAt: AssetAt): EffectsView {
  const tokenAccounts = tokenAccountsOf(effects);
  const events: EventView[] = [];
  const transfers: TransferView[] = [];
  const undecoded: string[] = [];
  for (const ix of effects.instructions) {
    const decoded = decodeInstruction(ix.programId, ix.accounts, ix.data, assetAt, tokenAccounts);
    if (!decoded.view.decoded) {
      undecoded.push(ix.programId);
      continue;
    }
    events.push({
      kind: 'instruction',
      source: ix.programId,
      decoder: decoded.view.decoder!,
      name: decoded.view.function!,
      args: decoded.view.args ?? [],
    });
    const transfer = transferOf(ix.programId, decoded, tokenAccounts, assetAt);
    if (transfer) transfers.push(transfer);
  }
  return {
    transfers,
    fee: {
      ...amountOf(assetAt, 'solana', NATIVE_ADDRESS, effects.fee),
      payer: effects.feePayer,
    },
    events,
    undecodedEvents: undecoded.length,
    undecodedEventSources: undecodedSources(undecoded),
    truncated: effects.truncated,
  };
}
