import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, SystemProgram, VersionedMessage } from '@solana/web3.js';
import {
  decodeFunctionData,
  erc20Abi,
  parseTransaction,
  toFunctionSelector,
  toHex,
  type Hex,
} from 'viem';

import type { Curve } from './backends/key-backend.js';

/**
 * A call or instruction that could move a token without being counted in
 * `tokens`. `token` is the contract it was sent to (EVM); absent, it could
 * touch any token (a Solana Token instruction other than a readable
 * TransferChecked, which names no mint the Signer can trust).
 */
export type UncountedTokenMove = { token?: string; what: string };

/** What one unsigned transaction does, as far as policy cares. */
export type TransactionEffects = {
  chainId?: number;
  /** EVM call targets (lowercase), nested ones included; Solana program ids outside DEFAULT_SOLANA_PROGRAMS. */
  destinations: string[];
  /** EVM only: the transaction deploys a contract, so it has no destination to check. */
  createsContract: boolean;
  /** Wei or lamports. */
  native: bigint;
  /** Token address (lowercase) or mint -> base units, summed. */
  tokens: Map<string, bigint>;
  uncountedTokenMoves: UncountedTokenMove[];
};

export type Undecodable = { undecodable: string };

export const SOLANA_PROGRAMS = {
  system: SystemProgram.programId.toBase58(),
  token: TOKEN_PROGRAM_ID.toBase58(),
  token2022: TOKEN_2022_PROGRAM_ID.toBase58(),
  associatedToken: ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
  computeBudget: ComputeBudgetProgram.programId.toBase58(),
};

/** Programs every Solana payment needs, so allowedDestinations never has to list them. */
export const DEFAULT_SOLANA_PROGRAMS: ReadonlySet<string> = new Set(Object.values(SOLANA_PROGRAMS));

/** The one aggregator function the engine's Bulk Call uses (ADR-0038). */
const AGGREGATE3_VALUE_ABI = [
  {
    type: 'function',
    name: 'aggregate3Value',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'allowFailure', type: 'bool' },
          { name: 'value', type: 'uint256' },
          { name: 'callData', type: 'bytes' },
        ],
      },
    ],
    outputs: [],
  },
] as const;

const AGGREGATE3_VALUE = toFunctionSelector('aggregate3Value((address,bool,uint256,bytes)[])');
const ERC20_TRANSFER = toFunctionSelector('transfer(address,uint256)');

/**
 * Multicall3's other batch functions make calls this decoder doesn't read,
 * with the aggregator as sender, so an allowed aggregator would let them
 * past every rule.
 */
const UNREAD_BATCHES: ReadonlyMap<string, string> = new Map(
  [
    'aggregate((address,bytes)[])',
    'aggregate3((address,bool,bytes)[])',
    'tryAggregate(bool,(address,bytes)[])',
    'blockAndAggregate((address,bytes)[])',
    'tryBlockAndAggregate(bool,(address,bytes)[])',
  ].map((signature) => [toFunctionSelector(signature), signature.split('(')[0] ?? signature]),
);

class UndecodableError extends Error {}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function add(tokens: Map<string, bigint>, token: string, amount: bigint): void {
  tokens.set(token, (tokens.get(token) ?? 0n) + amount);
}

/**
 * Records one EVM call and returns the native value it moves: its own, or
 * what an aggregate3Value forwards if that is more. Multicall3 requires the
 * two to be equal, but a caller-named aggregator might not, so the larger
 * counts and they are never summed.
 */
function evmCall(effects: TransactionEffects, target: Hex, value: bigint, data: Hex): bigint {
  const to = target.toLowerCase();
  effects.destinations.push(to);
  const selector = data.slice(0, 10).toLowerCase();

  if (selector === AGGREGATE3_VALUE) {
    let calls;
    try {
      [calls] = decodeFunctionData({ abi: AGGREGATE3_VALUE_ABI, data }).args;
    } catch (cause) {
      throw new UndecodableError(`aggregate3Value calldata to ${to}: ${errorMessage(cause)}`);
    }
    let forwarded = 0n;
    for (const call of calls) forwarded += evmCall(effects, call.target, call.value, call.callData);
    return value > forwarded ? value : forwarded;
  }

  const batch = UNREAD_BATCHES.get(selector);
  if (batch) throw new UndecodableError(`${batch} to ${to} makes calls the Signer does not read`);

  if (selector === ERC20_TRANSFER) {
    let amount: bigint;
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data });
      if (decoded.functionName !== 'transfer') throw new Error('not transfer');
      amount = decoded.args[1];
    } catch (cause) {
      throw new UndecodableError(`ERC-20 transfer calldata to ${to}: ${errorMessage(cause)}`);
    }
    add(effects.tokens, to, amount);
    return value;
  }

  effects.uncountedTokenMoves.push({
    token: to,
    what: data === '0x' ? 'a plain call' : `call ${selector}`,
  });
  return value;
}

/** EIP-7702 delegation and blob transactions do things no rule here looks at. */
const EVM_TYPES = new Set(['legacy', 'eip2930', 'eip1559']);

export function decodeEvmTransaction(unsigned: Uint8Array): TransactionEffects | Undecodable {
  try {
    const tx = parseTransaction(toHex(unsigned));
    if (tx.type === undefined || !EVM_TYPES.has(tx.type)) {
      return { undecodable: `EVM transaction type ${String(tx.type)} is not supported` };
    }
    const effects: TransactionEffects = {
      ...(tx.chainId === undefined ? {} : { chainId: tx.chainId }),
      destinations: [],
      createsContract: false,
      native: 0n,
      tokens: new Map(),
      uncountedTokenMoves: [],
    };
    const value = tx.value ?? 0n;
    if (tx.to) {
      effects.native = evmCall(effects, tx.to, value, tx.data ?? '0x');
    } else {
      effects.createsContract = true;
      effects.native = value;
    }
    return effects;
  } catch (cause) {
    if (cause instanceof UndecodableError) return { undecodable: cause.message };
    return { undecodable: `not an EVM transaction: ${errorMessage(cause)}` };
  }
}

/**
 * The System instructions that move lamports out of an account, by their
 * u32 index, and where in the data their u64 lamports sit. The rest
 * (Assign, Allocate, the nonce bookkeeping) move none.
 */
const SYSTEM_LAMPORTS_OFFSET: Record<number, (data: Buffer) => number> = {
  0: () => 4, // CreateAccount { lamports, space, owner }
  2: () => 4, // Transfer { lamports }
  // CreateAccountWithSeed { base, seed: u64 length + bytes, lamports, ... }
  3: (data) => 4 + 32 + 8 + Number(data.readBigUInt64LE(36)),
  5: () => 4, // WithdrawNonceAccount { lamports }
  11: () => 4, // TransferWithSeed { lamports, seed, owner }
};
const LAST_SYSTEM_INSTRUCTION = 12;

function systemLamports(data: Buffer): bigint {
  try {
    const index = data.readUInt32LE(0);
    if (index > LAST_SYSTEM_INSTRUCTION) throw new Error(`unknown instruction ${index}`);
    const offset = SYSTEM_LAMPORTS_OFFSET[index];
    return offset ? data.readBigUInt64LE(offset(data)) : 0n;
  } catch (cause) {
    throw new UndecodableError(`System instruction data: ${errorMessage(cause)}`);
  }
}

const TRANSFER_CHECKED = 12;

export function decodeSolanaMessage(unsigned: Uint8Array): TransactionEffects | Undecodable {
  try {
    let message: VersionedMessage;
    try {
      message = VersionedMessage.deserialize(unsigned);
    } catch (cause) {
      return { undecodable: `not a Solana message: ${errorMessage(cause)}` };
    }
    // What the runtime executes is these exact bytes, so any the decoder skipped would be unchecked.
    if (!Buffer.from(message.serialize()).equals(Buffer.from(unsigned))) {
      return { undecodable: 'the Solana message has bytes its decoding does not account for' };
    }

    const keys = message.staticAccountKeys;
    const staticKey = (index: number | undefined): PublicKey | undefined =>
      index === undefined ? undefined : keys[index];

    const effects: TransactionEffects = {
      destinations: [],
      createsContract: false,
      native: 0n,
      tokens: new Map(),
      uncountedTokenMoves: [],
    };
    for (const instruction of message.compiledInstructions) {
      const program = staticKey(instruction.programIdIndex)?.toBase58();
      if (program === undefined) {
        throw new UndecodableError('an instruction names its program through a lookup table');
      }
      const data = Buffer.from(instruction.data);
      if (!DEFAULT_SOLANA_PROGRAMS.has(program)) {
        effects.destinations.push(program);
      } else if (program === SOLANA_PROGRAMS.system) {
        effects.native += systemLamports(data);
      } else if (program === SOLANA_PROGRAMS.token || program === SOLANA_PROGRAMS.token2022) {
        // TransferChecked: u8 12, u64 amount, u8 decimals; accounts source, mint, destination, owner.
        const isTransferChecked = data[0] === TRANSFER_CHECKED && data.length >= 10;
        const mint = staticKey(instruction.accountKeyIndexes[1])?.toBase58();
        if (isTransferChecked && mint !== undefined) {
          add(effects.tokens, mint, data.readBigUInt64LE(1));
        } else {
          effects.uncountedTokenMoves.push({
            what: isTransferChecked
              ? 'a TransferChecked whose mint comes from an address lookup table'
              : `Token instruction ${data[0] ?? '(empty)'}`,
          });
        }
      }
    }
    return effects;
  } catch (cause) {
    if (cause instanceof UndecodableError) return { undecodable: cause.message };
    throw cause;
  }
}

export function decodeTransaction(
  curve: Curve,
  unsigned: Uint8Array,
): TransactionEffects | Undecodable {
  return curve === 'secp256k1' ? decodeEvmTransaction(unsigned) : decodeSolanaMessage(unsigned);
}
