import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, PublicKey, TransactionInstruction } from '@solana/web3.js';

import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';

/**
 * Solana account details, handled once as their own piece of
 * infrastructure (`.scratch/solana-chain-handler/issues/01`): every later
 * transfer path (issue 02 doesn't need this — a native SOL transfer has no
 * ATA; issue 03 does) derives/checks/creates a recipient's Associated Token
 * Account through this module rather than re-deriving it inline.
 */

/** Deterministic PDA derivation only — never touches the network, never throws for a well-formed owner/mint (both already validated by the time a Call reaches here). */
export function deriveAssociatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
}

/**
 * Whether an ATA already exists on-chain. Only ever informational (e.g. for
 * a caller that wants to skip the create instruction as an optimization) —
 * `idempotentCreateAtaInstruction` below is what every real transfer path
 * actually relies on, precisely so nothing needs this existence check on
 * the hot path.
 */
export async function associatedTokenAccountExists(
  connection: Connection,
  ata: PublicKey,
): Promise<Result<boolean, DispatchError>> {
  try {
    const info = await connection.getAccountInfo(ata);
    return ok(info !== null);
  } catch (cause) {
    return err({
      code: 'RPC_UNAVAILABLE',
      message: `failed to check whether ATA ${ata.toBase58()} exists`,
      chainDetail: cause instanceof Error ? cause.message : cause,
    });
  }
}

/**
 * The idempotent-create-if-missing instruction: costs nothing extra if the
 * ATA already exists (the program itself no-ops in that case), so it is
 * always safe to prepend to a transfer rather than doing a separate
 * existence check per recipient first — the whole reason this issue exists
 * as its own piece of infrastructure rather than an inline existence check
 * per caller.
 */
export function idempotentCreateAtaInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const ata = deriveAssociatedTokenAddress(owner, mint);
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    ata,
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}
