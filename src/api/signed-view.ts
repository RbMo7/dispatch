import { ComputeBudgetProgram, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import {
  getAddress,
  parseTransaction,
  recoverTransactionAddress,
  type TransactionSerializedEIP1559,
} from 'viem';

import { signedTransactionHex } from '../chain-handler/base/transaction-codec.js';
import type { Chain } from '../domain/chain.js';

/** A Base transaction version's EIP-1559 fees, in wei, read from its signed bytes. */
export type FeeView = { maxFeePerGas: string; maxPriorityFeePerGas: string };

/** What a Relay Dispatch's signed bytes say: who signed, what they call or pay, and the native value they move. */
export type RelaySignedView = {
  signer?: string;
  target?: string;
  value?: { asset: string; amount: string; decimals: number };
};

/** The fees a Base version was signed with, so a fee bump can show before and after; nothing for Solana or unreadable bytes. */
export function feeOf(chain: Chain, signedBytes: string | null): FeeView | undefined {
  if (chain !== 'base' || signedBytes === null) return undefined;
  const hex = signedTransactionHex(signedBytes);
  if (!hex) return undefined;
  try {
    const tx = parseTransaction(hex);
    if (tx.type !== 'eip1559' || tx.maxFeePerGas === undefined) return undefined;
    return {
      maxFeePerGas: tx.maxFeePerGas.toString(),
      maxPriorityFeePerGas: (tx.maxPriorityFeePerGas ?? 0n).toString(),
    };
  } catch {
    return undefined;
  }
}

/**
 * Reads a Relay Dispatch's signed bytes, with no RPC: the signer, the target
 * and the native value. On Base the target is `to`; on Solana it is the
 * recipient of a System transfer, else the first program called other than
 * the Compute Budget program. Whatever cannot be read is left out.
 */
export async function relaySignedView(chain: Chain, signed: string): Promise<RelaySignedView> {
  return chain === 'base' ? baseRelay(signed) : solanaRelay(signed);
}

async function baseRelay(signed: string): Promise<RelaySignedView> {
  const hex = signedTransactionHex(signed);
  if (!hex) return {};
  try {
    const tx = parseTransaction(hex);
    const signer = await recoverTransactionAddress({
      serializedTransaction: hex as TransactionSerializedEIP1559,
    }).catch(() => undefined);
    return {
      ...(signer ? { signer } : {}),
      ...(tx.to ? { target: getAddress(tx.to) } : {}),
      value: { asset: 'ETH', amount: (tx.value ?? 0n).toString(), decimals: 18 },
    };
  } catch {
    return {};
  }
}

const SYSTEM = SystemProgram.programId.toBase58();
const COMPUTE_BUDGET = ComputeBudgetProgram.programId.toBase58();
/** The System program's `Transfer` instruction: a u32 index of 2, then the lamports as a u64. */
const TRANSFER = 2;

function solanaRelay(signed: string): RelaySignedView {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(signed, 'base64'));
  } catch {
    return {};
  }
  const keys = tx.message.staticAccountKeys.map((key) => key.toBase58());
  const signer = keys[0];
  const view: RelaySignedView = signer ? { signer } : {};
  const instruction = tx.message.compiledInstructions.find(
    (ix) => keys[ix.programIdIndex] !== COMPUTE_BUDGET,
  );
  if (!instruction) return view;
  const program = keys[instruction.programIdIndex];
  const data = Buffer.from(instruction.data);
  const recipient = keys[instruction.accountKeyIndexes[1] ?? -1];
  if (program === SYSTEM && data.length === 12 && data.readUInt32LE(0) === TRANSFER && recipient) {
    return {
      ...view,
      target: recipient,
      value: { asset: 'SOL', amount: data.readBigUInt64LE(4).toString(), decimals: 9 },
    };
  }
  return program ? { ...view, target: program } : view;
}
