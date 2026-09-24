import { PublicKey, SystemProgram } from '@solana/web3.js';

import type { SolanaCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
import { fromTransactionInstruction } from './instruction-codec.js';

/**
 * A plain native-SOL disbursement (`.scratch/solana-chain-handler/issues/02`)
 * — no token/mint involved, no ATA (issue 01 doesn't apply to a native
 * transfer at all). `SystemProgram.transfer` is the only real chain
 * knowledge here; the rest is `SolanaCall`'s ordinary opaque shape.
 */
export function parsePublicKey(address: string): Result<PublicKey, DispatchError> {
  try {
    return ok(new PublicKey(address));
  } catch (cause) {
    return err({
      code: 'INVALID_RECIPIENT',
      message: `not a well-formed Solana address: ${address}`,
      chainDetail: cause instanceof Error ? cause.message : cause,
    });
  }
}

export function buildNativeTransferCall(
  senderAddress: string,
  recipient: string,
  lamports: bigint,
): Result<SolanaCall, DispatchError> {
  const from = parsePublicKey(senderAddress);
  if (!from.ok) return from;

  const to = parsePublicKey(recipient);
  if (!to.ok) return to;

  const instruction = SystemProgram.transfer({
    fromPubkey: from.value,
    toPubkey: to.value,
    lamports,
  });
  return ok(fromTransactionInstruction(instruction));
}

/** Cheap shape validation only (ADR: validateCall never round-trips to RPC). */
export function validateNativeTransferCall(call: SolanaCall): Result<void, DispatchError> {
  const destination = call.accounts[1];
  if (call.accounts.length !== 2 || !destination) {
    return err({
      code: 'INVALID_RECIPIENT',
      message: `a native SOL transfer must name exactly 2 accounts (from, to), got ${call.accounts.length}`,
    });
  }
  const to = parsePublicKey(destination.pubkey);
  if (!to.ok) return to;
  return ok(undefined);
}
