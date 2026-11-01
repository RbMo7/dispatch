import { readFileSync } from 'node:fs';

import { Connection } from '@solana/web3.js';

import { registryFromConfig } from '../../asset-registry/configured-assets.js';
import { BaseChainHandler } from '../../chain-handler/base/base-chain-handler.js';
import { SolanaChainHandler } from '../../chain-handler/solana/solana-chain-handler.js';
import type { TransactionEffects } from '../../domain/effects.js';
import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import type { AssetAt } from '../view.js';

/**
 * Transactions the flows run (`scripts/flows/`, rows 1, 2, 4, 5, 6 and 7) sent
 * on Base Sepolia and devnet on 2026-11-01, as the nodes answered for them.
 * Each is read through the real chain handler, then decoded.
 */
export type Recorded = { chain: 'base' | 'solana'; hash: string; rpc: Record<string, unknown> };

export const FLOW = '0xF98CeD8B8b3902FF2d917708D02F7E5A98f73c3d';
export const VAULT = '0x79bB95AEF7f032144A9A5C6933B8d13a98e6D793';
export const AGGREGATOR = '0xb4AE694A6b3Bc58CC4C31d983a74dBC3947eA318';
export const BASE_PAYOUTS = '0x8cdBF57d39066712E9eDADb0822D7b89E7699e06';
export const BASE_REFUNDS = '0xA5A6c5BE8d67c023a32723491389d8be1C9Cd20D';
export const BASE_RELAY = '0x206412f2466515d48ddD8d4150331f9553d557c7';
export const FSPL = '8JT4gPRofGbe1UWhm2NKMFj1RLwkfdGT2KXqHoSrp9P';
export const F22 = '8iGTbRvoqD6o6ZCFZsS4ai1bU1hEm7mbvwZsjbwrALcC';
export const SOL_PAYOUTS = 'A5NFXd9Na4vByXkUZpoYz4efigSGFTsUbbduphKiSWtH';
export const SOL_REFUNDS = 'GP2AWqx49PtpcqChfWjpQWCpmxQsn29PVwdF1AezeWRd';
export const SOL_RELAY = 'EbihtazafkcEX88FVksBDnoy14F5Jc29mAW94eMbKtWF';
export const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

export const registry = registryFromConfig({
  base: `FLOW:${FLOW}:6`,
  solana: `FSPL:${FSPL}:6,F22:${F22}:6:token-2022`,
});
export const assetAt: AssetAt = (chain, address) => registry.forChain(chain).byAddress(address);
export const asset = (address: string, symbol: string, decimals: number, name = symbol) => ({
  address,
  symbol,
  name,
  decimals,
});
export const ETH = asset('native', 'ETH', 18, 'Ether');
export const SOL = asset('native', 'SOL', 9, 'Solana');

export function recorded(name: string): Recorded {
  return JSON.parse(
    readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), 'utf8'),
  ) as Recorded;
}

/** Answers exactly the recorded methods, plus what the Base handler asks before anything else. */
function rpcServing(answers: Record<string, unknown>): typeof fetch {
  const known: Record<string, unknown> = {
    eth_chainId: '0x14a34',
    eth_getTransactionCount: '0x0',
    ...answers,
  };
  return (_input, init) => {
    const { id, method } = JSON.parse(init?.body as string) as { id: number; method: string };
    if (!(method in known)) return Promise.reject(new Error(`unexpected RPC ${method}`));
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: known[method] }));
  };
}

/** Reads a recorded transaction through the chain's real handler, as the worker does. */
export async function readRecorded(name: string): Promise<TransactionEffects> {
  const { chain, hash, rpc } = recorded(name);
  const handler =
    chain === 'base'
      ? await BaseChainHandler.create({
          rpcUrl: 'http://base.invalid',
          chainId: 84532,
          senderAddress: BASE_PAYOUTS,
          assets: registry.forChain('base'),
          nonceHistoryStore: new InMemoryNonceHistoryStore(),
          bulkCallMaxBatchSize: 50,
          fetch: rpcServing(rpc),
        })
      : new SolanaChainHandler({
          connection: new Connection('http://solana.invalid', { fetch: rpcServing(rpc) }),
          senderAddress: SOL_PAYOUTS,
          assets: registry.forChain('solana'),
        });
  const read = await handler.readEffects(hash);
  if (!read.ok) throw new Error(`${name}: ${read.error.message}`);
  return read.value;
}
