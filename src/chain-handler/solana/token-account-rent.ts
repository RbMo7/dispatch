import {
  ACCOUNT_SIZE,
  ExtensionType,
  getAccountLen,
  getAccountTypeOfMintType,
  getExtensionTypes,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { Connection, PublicKey } from '@solana/web3.js';

/**
 * Rent for one recipient token account of `mint`: fixed for classic Token;
 * for Token-2022 (#41) sized by the account extensions the mint's own
 * extensions imply, plus ImmutableOwner, which the Associated Token program
 * always adds to a Token-2022 account. Shared by the Funding Check's
 * `networkCost` and a Multisig Sender's `estimateApprovalCost`.
 */
export async function tokenAccountRent(
  connection: Pick<Connection, 'getAccountInfo' | 'getMinimumBalanceForRentExemption'>,
  mint: PublicKey,
  tokenProgram: PublicKey,
): Promise<number> {
  let size = ACCOUNT_SIZE;
  if (tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) {
    const { tlvData } = await getMint(connection as Connection, mint, 'confirmed', tokenProgram);
    const extensions = new Set(getExtensionTypes(tlvData).map(getAccountTypeOfMintType));
    extensions.delete(ExtensionType.Uninitialized); // mint-only extensions
    extensions.add(ExtensionType.ImmutableOwner);
    size = getAccountLen([...extensions]);
  }
  return connection.getMinimumBalanceForRentExemption(size);
}
