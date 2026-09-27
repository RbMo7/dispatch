import { createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import type { PublicKey } from '@solana/web3.js';

import type { SolanaCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
import { deriveAssociatedTokenAddress, isTokenProgram } from './account-resolution.js';
import { fromTransactionInstruction } from './instruction-codec.js';
import { parsePublicKey } from './native-transfer.js';

/**
 * A token disbursement (`.scratch/solana-chain-handler/issues/03`) via
 * `createTransferCheckedInstruction` — distinct from issue 02 because the
 * failure modes are genuinely different (malformed mint, decimals
 * mismatch, an unfunded/nonexistent source ATA) and because it needs issue
 * 01's account resolution for both sides' ATAs. The recipient's owner
 * wallet is appended as a 5th account purely so `prepare()`
 * (instruction-codec.ts) can recover it to build the idempotent
 * create-ATA instruction — see that file for why.
 */
export function buildSplTransferCall(
  senderAddress: string,
  recipient: string,
  mint: string,
  decimals: number,
  rawAmount: bigint,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID,
): Result<SolanaCall, DispatchError> {
  const owner = parsePublicKey(senderAddress);
  if (!owner.ok) return owner;

  const recipientOwner = parsePublicKey(recipient);
  if (!recipientOwner.ok) return recipientOwner;

  const mintKey = parsePublicKey(mint);
  if (!mintKey.ok) {
    return err({ ...mintKey.error, message: `not a well-formed mint address: ${mint}` });
  }

  const sourceAta = deriveAssociatedTokenAddress(owner.value, mintKey.value, tokenProgram);
  const destinationAta = deriveAssociatedTokenAddress(recipientOwner.value, mintKey.value, tokenProgram);

  const instruction = createTransferCheckedInstruction(
    sourceAta,
    mintKey.value,
    destinationAta,
    owner.value,
    rawAmount,
    decimals,
    [],
    tokenProgram,
  );
  const call = fromTransactionInstruction(instruction);

  return ok({
    ...call,
    accounts: [
      ...call.accounts,
      { pubkey: recipientOwner.value.toBase58(), isSigner: false, isWritable: false },
    ],
  });
}

/** Cheap shape validation only — a real amount/decimals/balance mismatch surfaces as CHAIN_REJECTED at broadcast (issue 09), never here. */
export function validateSplTransferCall(call: SolanaCall): Result<void, DispatchError> {
  if (!isTokenProgram(call.programId)) {
    return err({
      code: 'INVALID_RECIPIENT',
      message: `not an SPL Token program call: ${call.programId}`,
    });
  }
  if (call.accounts.length !== 4 && call.accounts.length !== 5) {
    return err({
      code: 'INVALID_RECIPIENT',
      message: `an SPL transferChecked call must name 4 or 5 accounts, got ${call.accounts.length}`,
    });
  }
  for (const account of call.accounts) {
    const parsed = parsePublicKey(account.pubkey);
    if (!parsed.ok) return parsed;
  }
  if (call.data.length === 0) {
    return err({
      code: 'INVALID_RECIPIENT',
      message: 'transferChecked call has no instruction data',
    });
  }
  return ok(undefined);
}

export function isSplTransferCall(call: SolanaCall): boolean {
  return isTokenProgram(call.programId);
}
