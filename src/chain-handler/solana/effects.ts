import type { TokenBalance, VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';

import {
  EFFECTS_BOUNDS,
  type SolanaEffects,
  type SolanaInstruction,
  type SolanaTokenBalance,
} from '../../domain/effects.js';

/** ADR-0063: a confirmed transaction as stored, cut to `EFFECTS_BOUNDS`. Pure. */
export function solanaEffectsFrom(response: VersionedTransactionResponse): SolanaEffects {
  const { message } = response.transaction;
  const meta = response.meta;
  // v0 lookup-table accounts follow the static ones, writable first, as the indexes count them.
  const keys = [
    ...message.staticAccountKeys,
    ...(meta?.loadedAddresses?.writable ?? []),
    ...(meta?.loadedAddresses?.readonly ?? []),
  ].map((key) => key.toBase58());
  const keyAt = (index: number) => keys[index] ?? `#${index}`;

  let truncated = false;
  const bounded = <T>(list: T[], max: number = EFFECTS_BOUNDS.entries): T[] => {
    if (list.length > max) truncated = true;
    return list.slice(0, max);
  };
  const data = (bytes: Uint8Array) => {
    if (bytes.length > EFFECTS_BOUNDS.dataBytes) truncated = true;
    return Buffer.from(bytes.subarray(0, EFFECTS_BOUNDS.dataBytes)).toString('base64');
  };

  const instructions: SolanaInstruction[] = [];
  message.compiledInstructions.forEach((ix, index) => {
    instructions.push({
      programId: keyAt(ix.programIdIndex),
      accounts: ix.accountKeyIndexes.map(keyAt),
      data: data(ix.data),
      parent: null,
    });
    const inner = meta?.innerInstructions?.find((set) => set.index === index);
    for (const invoked of inner?.instructions ?? []) {
      instructions.push({
        programId: keyAt(invoked.programIdIndex),
        accounts: invoked.accounts.map(keyAt),
        data: data(bs58.decode(invoked.data)),
        parent: index,
      });
    }
  });

  const lamports = keys.map((account, index) => ({
    account,
    pre: String(meta?.preBalances[index] ?? 0),
    post: String(meta?.postBalances[index] ?? 0),
  }));

  const tokenBalances = new Map<number, SolanaTokenBalance>();
  const note = (balance: TokenBalance, side: 'pre' | 'post') => {
    const held = tokenBalances.get(balance.accountIndex) ?? {
      account: keyAt(balance.accountIndex),
      mint: balance.mint,
      owner: balance.owner ?? null,
      decimals: balance.uiTokenAmount.decimals,
      pre: '0',
      post: '0',
    };
    tokenBalances.set(balance.accountIndex, { ...held, [side]: balance.uiTokenAmount.amount });
  };
  for (const balance of meta?.preTokenBalances ?? []) note(balance, 'pre');
  for (const balance of meta?.postTokenBalances ?? []) note(balance, 'post');

  const logMessages = bounded(meta?.logMessages ?? [], EFFECTS_BOUNDS.logLines).map((line) => {
    if (line.length > EFFECTS_BOUNDS.logLineChars) truncated = true;
    return line.slice(0, EFFECTS_BOUNDS.logLineChars);
  });

  return {
    chain: 'solana',
    slot: response.slot,
    feePayer: keyAt(0),
    fee: String(meta?.fee ?? 0),
    instructions: bounded(instructions),
    lamports: bounded(lamports),
    tokenBalances: bounded([...tokenBalances.values()]),
    logMessages,
    truncated,
  };
}
