import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from 'viem';
import { RpcError } from '../errors.js';
import { JsonRpc } from '../jsonrpc.js';

/** What the Safe check needs from the chain: the chain id and read-only calls. */
export interface EvmRpc {
  chainId(): Promise<number>;
  call(to: string, data: Hex): Promise<Hex>;
}

export function evmRpc(rpc: JsonRpc): EvmRpc {
  return {
    async chainId() {
      const hex = await rpc.call<string>('eth_chainId', []);
      return Number(BigInt(hex));
    },
    async call(to, data) {
      return rpc.call<Hex>('eth_call', [{ to, data }, 'latest']);
    },
  };
}

const SAFE_ABI = parseAbi([
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

export interface SafeState {
  /** `VERSION()` with any `+L2` suffix removed. */
  version: string;
  nonce: bigint;
  threshold: bigint;
  owners: string[];
}

async function read<T>(
  rpc: EvmRpc,
  safe: string,
  functionName: 'VERSION' | 'nonce' | 'getThreshold' | 'getOwners',
): Promise<T> {
  let raw: Hex;
  try {
    raw = await rpc.call(safe, encodeFunctionData({ abi: SAFE_ABI, functionName }));
  } catch (e) {
    throw new RpcError(
      `reading ${functionName}() on ${safe} failed: ${(e as Error).message}. Is it a Safe on this chain?`,
    );
  }
  if (raw === '0x')
    throw new RpcError(
      `${safe} returned nothing for ${functionName}(): there is no Safe at that address on this chain`,
    );
  try {
    return decodeFunctionResult({ abi: SAFE_ABI, functionName, data: raw }) as T;
  } catch {
    throw new RpcError(`${safe} answered ${functionName}() with data that is not a Safe's`);
  }
}

export async function readSafe(rpc: EvmRpc, safe: string): Promise<SafeState> {
  const version = await read<string>(rpc, safe, 'VERSION');
  const nonce = await read<bigint>(rpc, safe, 'nonce');
  const threshold = await read<bigint>(rpc, safe, 'getThreshold');
  const owners = await read<readonly string[]>(rpc, safe, 'getOwners');
  return { version: version.split('+')[0] as string, nonce, threshold, owners: [...owners] };
}
