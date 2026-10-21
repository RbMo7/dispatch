import { JsonRpc } from '../jsonrpc.js';
import type { AccountReader } from './instructions.js';

interface AccountsResponse {
  value: ({ owner: string; data: [string, string] } | null)[];
}

/** Account reads over plain JSON-RPC `getMultipleAccounts`. */
export function solanaReader(rpc: JsonRpc): AccountReader {
  return async (addresses) => {
    const out: Awaited<ReturnType<AccountReader>> = [];
    for (let i = 0; i < addresses.length; i += 100) {
      const batch = addresses.slice(i, i + 100);
      const res = await rpc.call<AccountsResponse>('getMultipleAccounts', [
        batch,
        { encoding: 'base64', commitment: 'confirmed' },
      ]);
      for (const v of res.value)
        out.push(
          v ? { owner: v.owner, data: Uint8Array.from(Buffer.from(v.data[0], 'base64')) } : null,
        );
    }
    return out;
  };
}

export async function genesisHash(rpc: JsonRpc): Promise<string | undefined> {
  try {
    return await rpc.call<string>('getGenesisHash', []);
  } catch {
    return undefined;
  }
}
