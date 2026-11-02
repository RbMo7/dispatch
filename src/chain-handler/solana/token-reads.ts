import {
  AccountState,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionData,
  getNonTransferable,
  getTransferFeeConfig,
  getTransferHook,
  unpackMint,
  type Mint,
} from '@solana/spl-token';
import { PublicKey, type Connection } from '@solana/web3.js';

import { err, ok, type Result } from '../../domain/result.js';
import type { TokenRead, TokenReadError } from '../chain-handler.js';
import { extractMessage } from './error-mapping.js';

const METAPLEX_METADATA_PROGRAM_ID = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

/**
 * Mainnet review: why a mint can't be paid out correctly, or undefined when it
 * can. A nonzero transfer fee lands recipients short of the amount reported,
 * a transfer hook needs accounts a payment doesn't carry, and a frozen default
 * state stops new recipients receiving it. A fee set later still slips past.
 */
export function payoutRefusal(mint: Mint): string | undefined {
  const fee = getTransferFeeConfig(mint);
  if (
    fee &&
    (fee.olderTransferFee.transferFeeBasisPoints > 0 ||
      fee.newerTransferFee.transferFeeBasisPoints > 0)
  ) {
    return 'it charges a transfer fee, so recipients would get less than the amount paid';
  }
  const hook = getTransferHook(mint);
  if (hook && !hook.programId.equals(PublicKey.default)) {
    return 'it has a transfer hook, which needs accounts a payment does not carry';
  }
  if (getNonTransferable(mint)) return 'it is non-transferable';
  if (getDefaultAccountState(mint)?.state === AccountState.Frozen) {
    return "new token accounts start frozen, so new recipients couldn't receive it";
  }
  return undefined;
}

/** A Borsh string (u32 length, then UTF-8), as both metadata layouts store name and symbol; padding NULs dropped. */
function borshString(data: Buffer, offset: number): { value: string; next: number } {
  const length = data.readUInt32LE(offset);
  const start = offset + 4;
  const value = data
    .subarray(start, start + length)
    .toString('utf8')
    .replace(/\0/g, '')
    .trim();
  return { value, next: start + length };
}

/** Name and symbol from a layout that starts with `skip` bytes before them; empty when the bytes don't hold them. */
function nameAndSymbol(data: Buffer, skip: number): { name: string; symbol: string } {
  try {
    const name = borshString(data, skip);
    return { name: name.value, symbol: borshString(data, name.next).value };
  } catch {
    return { name: '', symbol: '' };
  }
}

/** Token-2022's own metadata extension, else the Metaplex metadata account. */
async function readMetadata(
  connection: Connection,
  mintAddress: PublicKey,
  mint: Mint,
): Promise<{ name: string; symbol: string }> {
  // The extension starts with the update authority and the mint, 32 bytes each.
  const extension = getExtensionData(ExtensionType.TokenMetadata, mint.tlvData);
  if (extension) return nameAndSymbol(extension, 64);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_METADATA_PROGRAM_ID.toBuffer(), mintAddress.toBuffer()],
    METAPLEX_METADATA_PROGRAM_ID,
  );
  const account = await connection.getAccountInfo(pda, 'confirmed');
  // A key byte, then the update authority and the mint.
  return account ? nameAndSymbol(account.data, 65) : { name: '', symbol: '' };
}

const notAToken = (message: string): Result<never, TokenReadError> =>
  err({ code: 'NOT_A_TOKEN', message });

/** ADR-0061: a mint's decimals, name, symbol and supply, refusing any address that is not a mint the engine can pay out. */
export async function readSolanaToken(
  connection: Connection,
  address: string,
): Promise<Result<TokenRead<'solana'>, TokenReadError>> {
  let mintAddress: PublicKey;
  try {
    mintAddress = new PublicKey(address);
  } catch {
    return notAToken(`${address} is not a Solana address`);
  }
  try {
    const account = await connection.getAccountInfo(mintAddress, 'confirmed');
    if (!account) return notAToken(`no account exists at ${address} on this cluster`);
    const program = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].find((id) =>
      account.owner.equals(id),
    );
    if (!program) {
      return notAToken(
        `${address} is owned by ${account.owner.toBase58()}, not a token program, so it is not a mint`,
      );
    }
    let mint: Mint;
    try {
      mint = unpackMint(mintAddress, account, program);
    } catch {
      return notAToken(`${address} is a token program account but not a mint (a token account?)`);
    }
    const refusal = payoutRefusal(mint);
    if (refusal)
      return err({ code: 'NOT_PAYABLE', message: `${address} can't be paid out: ${refusal}` });
    const { name, symbol } = await readMetadata(connection, mintAddress, mint);
    return ok({
      chain: 'solana',
      kind: program.equals(TOKEN_2022_PROGRAM_ID) ? 'token-2022' : 'spl',
      address: mintAddress.toBase58(),
      symbol,
      name,
      decimals: mint.decimals,
      supply: mint.supply.toString(),
    });
  } catch (cause) {
    return err({
      code: 'RPC_UNAVAILABLE',
      message: `could not read ${address}: ${extractMessage(cause)}`,
    });
  }
}
