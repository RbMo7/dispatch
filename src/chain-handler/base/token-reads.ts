import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  getAddress,
  HttpRequestError,
  TimeoutError,
  hexToString,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

import { err, ok, type Result } from '../../domain/result.js';
import type { TokenRead, TokenReadError } from '../chain-handler.js';

const METADATA_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'totalSupply',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
] as const;

/** Some early tokens (MKR among them) return name and symbol as bytes32. */
const BYTES32_ABI = [
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }],
  },
] as const;

/** The contract answered, but not as an ERC-20 would: as opposed to the RPC failing. */
function isNotAnswered(cause: unknown): boolean {
  return (
    cause instanceof BaseError &&
    cause.walk(
      (e) =>
        e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError,
    ) !== null
  );
}

function isTransportFailure(cause: BaseError): boolean {
  return cause.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null;
}

/** An empty string when the token publishes no such text. */
async function readText(
  client: PublicClient,
  address: Address,
  fn: 'name' | 'symbol',
): Promise<string> {
  try {
    return (await client.readContract({ address, abi: METADATA_ABI, functionName: fn })).trim();
  } catch (cause) {
    if (!(cause instanceof BaseError) || isTransportFailure(cause)) throw cause;
  }
  try {
    const raw: Hex = await client.readContract({ address, abi: BYTES32_ABI, functionName: fn });
    return hexToString(raw, { size: 32 }).replace(/\0/g, '').trim();
  } catch (cause) {
    if (!(cause instanceof BaseError) || isTransportFailure(cause)) throw cause;
    return '';
  }
}

/** ADR-0061: an ERC-20's decimals, name, symbol and supply, refusing an address that does not answer as one. */
export async function readBaseToken(
  client: PublicClient,
  address: string,
): Promise<Result<TokenRead<'base'>, TokenReadError>> {
  if (!isAddress(address, { strict: false })) {
    return err({ code: 'NOT_A_TOKEN', message: `${address} is not an EVM address` });
  }
  const contract = getAddress(address);
  try {
    const code = await client.getCode({ address: contract });
    if (!code || code === '0x') {
      return err({
        code: 'NOT_A_TOKEN',
        message: `${contract} has no contract code on this chain`,
      });
    }
    let decimals: number;
    let supply: bigint;
    try {
      [decimals, supply] = await Promise.all([
        client.readContract({ address: contract, abi: METADATA_ABI, functionName: 'decimals' }),
        client.readContract({ address: contract, abi: METADATA_ABI, functionName: 'totalSupply' }),
      ]);
    } catch (cause) {
      if (!isNotAnswered(cause)) throw cause;
      return err({
        code: 'NOT_A_TOKEN',
        message: `${contract} does not answer decimals() and totalSupply(), so it is not an ERC-20 token`,
      });
    }
    const [name, symbol] = await Promise.all([
      readText(client, contract, 'name'),
      readText(client, contract, 'symbol'),
    ]);
    return ok({
      chain: 'base',
      kind: 'erc20',
      address: contract,
      symbol,
      name,
      decimals,
      supply: supply.toString(),
    });
  } catch (cause) {
    const message = cause instanceof BaseError ? cause.shortMessage : String(cause);
    return err({ code: 'RPC_UNAVAILABLE', message: `could not read ${contract}: ${message}` });
  }
}
