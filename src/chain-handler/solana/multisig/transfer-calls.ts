import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { SystemProgram } from '@solana/web3.js';

import type { SolanaCall } from '../../../domain/call.js';
import type { DispatchError } from '../../../domain/errors.js';
import { err, ok, type Result } from '../../../domain/result.js';
import { isTokenProgram } from '../account-resolution.js';
import type { AssetLookup } from '../../../asset-registry/asset-registry.js';
import { NATIVE_ASSET_SYMBOL } from '../known-tokens.js';

/** SPL Token's TransferChecked discriminant and its data length: 1 + u64 amount + u8 decimals. */
const TRANSFER_CHECKED = 12;
const TRANSFER_CHECKED_LENGTH = 10;
/** The System program's Transfer instruction: u32 index 2, then u64 lamports. */
const SYSTEM_TRANSFER = 2;
const SYSTEM_TRANSFER_LENGTH = 12;

/** What a proposable Call pays, read from the Call itself (ADR-0049: the engine proposes payments, never arbitrary calls). */
export type TransferSummary = {
  /** The recipient wallet (a 5-account SPL Call names it), else the destination account. */
  recipient: string;
  /** `SOL`, a known token's symbol, or the mint address when the token is not configured. */
  asset: string;
  amount: bigint;
};

const refuse = (message: string): Result<never, DispatchError> =>
  err({ code: 'CHAIN_REJECTED', message });

/**
 * Reads a Call a Multisig Sender may propose: a native SOL transfer or an SPL
 * (classic or Token-2022) `transferChecked`, paid from `vault`. Anything else
 * (an arbitrary contract call, another System or Token instruction, a payment
 * from another account, any signer but the vault) is refused: Approvers are
 * shown what the Proposal pays out, and the engine can only describe that for
 * transfers.
 */
export function summarizeTransfer(
  call: SolanaCall,
  vault: string,
  assets: AssetLookup<'solana'>,
): Result<TransferSummary, DispatchError> {
  const stranger = call.accounts.find((a) => a.isSigner && a.pubkey !== vault);
  if (stranger) {
    return refuse(
      `a Multisig Sender can only propose calls signed by its vault; ${stranger.pubkey} would have to sign`,
    );
  }
  const data = Buffer.from(call.data, 'base64');

  if (call.programId === SystemProgram.programId.toBase58()) {
    if (
      call.accounts.length !== 2 ||
      data.length !== SYSTEM_TRANSFER_LENGTH ||
      data.readUInt32LE(0) !== SYSTEM_TRANSFER
    ) {
      return refuse('a Multisig Sender can only propose native SOL transfers and token transfers');
    }
    if (call.accounts[0]!.pubkey !== vault) {
      return refuse(`the transfer pays from ${call.accounts[0]!.pubkey}, not the vault ${vault}`);
    }
    return ok({
      recipient: call.accounts[1]!.pubkey,
      asset: NATIVE_ASSET_SYMBOL,
      amount: data.readBigUInt64LE(4),
    });
  }

  if (
    isTokenProgram(call.programId) &&
    (call.accounts.length === 4 || call.accounts.length === 5) &&
    data.length === TRANSFER_CHECKED_LENGTH &&
    data[0] === TRANSFER_CHECKED
  ) {
    const owner = call.accounts[3]!.pubkey;
    if (owner !== vault) {
      return refuse(`the token transfer is authorized by ${owner}, not the vault ${vault}`);
    }
    const mint = call.accounts[1]!.pubkey;
    const token2022 = call.programId === TOKEN_2022_PROGRAM_ID.toBase58();
    const known = assets.byAddress(mint);
    const sameProgram = known && (known.kind === 'token-2022') === token2022;
    return ok({
      recipient: (call.accounts[4] ?? call.accounts[2]!).pubkey,
      asset: sameProgram ? known.symbol : mint,
      amount: data.readBigUInt64LE(1),
    });
  }

  return refuse('a Multisig Sender can only propose native SOL transfers and token transfers');
}
