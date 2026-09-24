import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

import type { SolanaAccountMeta, SolanaCall } from '../../domain/call.js';
import { idempotentCreateAtaInstruction } from './account-resolution.js';

/**
 * Translates between the engine-core-opaque `SolanaCall` shape
 * (`{programId, accounts, data}`, ADR-0018/docs/api.md) and a real
 * `@solana/web3.js` `TransactionInstruction` — the one place this
 * conversion happens, so `prepare()` never repeats it inline.
 */
export function toTransactionInstruction(call: SolanaCall): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(call.programId),
    keys: call.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(call.data, 'base64'),
  });
}

export function fromTransactionInstruction(instruction: TransactionInstruction): SolanaCall {
  return {
    programId: instruction.programId.toBase58(),
    accounts: instruction.keys.map(
      (k): SolanaAccountMeta => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      }),
    ),
    data: instruction.data.toString('base64'),
  };
}

/** SPL Token's TransferChecked instruction discriminant (spl-token's TokenInstruction enum). */
const TRANSFER_CHECKED_DISCRIMINANT = 12;

/**
 * `paymentToCall`'s SPL-transfer encoding (`spl-transfer.ts`) appends the
 * recipient wallet as a 5th account beyond TransferChecked's real 4
 * (source, mint, destination, owner) purely so `prepare()` can recover it
 * here to build the idempotent create-ATA instruction — TransferChecked's
 * own on-chain account list has no field for the recipient's *wallet*, only
 * their token account (CONTEXT.md's Call primitive is one instruction; this
 * is how a Call that needs two real instructions still fits that shape).
 * A caller-supplied raw SolanaCall in this exact shape gets the same
 * treatment — this isn't Payment-specific, it's shape-specific — but a
 * caller who omits the 5th account (the real on-chain minimum) is trusted
 * to have created the destination ATA themselves (ADR-0018: a Call the
 * caller already encoded, the engine doesn't second-guess it).
 */
function isSplTransferWithRecipientBookkeeping(call: SolanaCall): boolean {
  if (call.programId !== TOKEN_PROGRAM_ID.toBase58()) return false;
  if (call.accounts.length !== 5) return false;
  const data = Buffer.from(call.data, 'base64');
  return data.length > 0 && data[0] === TRANSFER_CHECKED_DISCRIMINANT;
}

/**
 * What `prepare()` actually submits for one Call — one instruction for a
 * plain transfer, or [create-ATA-idempotent, transfer] for an SPL transfer
 * whose destination ATA might not exist yet (issue 03). Never mutates
 * `call`.
 */
export function toTransactionInstructions(
  call: SolanaCall,
  payer: PublicKey,
): TransactionInstruction[] {
  if (isSplTransferWithRecipientBookkeeping(call)) {
    // Guarded by isSplTransferWithRecipientBookkeeping's own accounts.length === 5 check.
    const mint = new PublicKey(call.accounts[1]!.pubkey);
    const recipientWallet = new PublicKey(call.accounts[4]!.pubkey);
    const transfer = toTransactionInstruction({
      ...call,
      accounts: call.accounts.slice(0, 4),
    });
    return [idempotentCreateAtaInstruction(payer, recipientWallet, mint), transfer];
  }

  return [toTransactionInstruction(call)];
}

export function isNativeTransferCall(call: SolanaCall): boolean {
  return call.programId === SystemProgram.programId.toBase58();
}
