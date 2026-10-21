import {
  decodeAbiParameters,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/** Safe's `guard_manager.guard.address` storage slot, keccak256 of that string (spike #79). Non-zero means a guard is set. */
export const SAFE_GUARD_STORAGE_SLOT: Hex =
  '0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8';

/** The sentinel head of Safe's module linked list. */
const SENTINEL_MODULES: Address = '0x0000000000000000000000000000000000000001';

const SAFE_ABI = parseAbi([
  'function VERSION() view returns (string)',
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function nonce() view returns (uint256)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
]);

export type SafeOnChainState = {
  /** The block every value below was read at. */
  blockNumber: bigint;
  chainId: number;
  hasCode: boolean;
  version: string;
  owners: Address[];
  threshold: number;
  nonce: bigint;
  /** Non-zero address when a guard is set. */
  guard: Address;
  /** The first page (10) of enabled modules. */
  modules: Address[];
};

/** Everything `readSafeState` needs from viem, so tests can hand it a fake. */
export type SafeReadClient = Pick<
  PublicClient,
  'getChainId' | 'getBlockNumber' | 'getCode' | 'readContract' | 'getStorageAt'
>;

/**
 * Reads a Safe's state from the chain, the authority on who owns it (ADR-0051).
 * Every read is pinned to one block read once up front: the public Base
 * Sepolia RPC returned stale values right after a receipt (spike #79), and
 * pinning keeps the values consistent with each other.
 * Returns `hasCode: false` (other fields empty) for an address with no contract.
 */
export async function readSafeState(
  client: SafeReadClient,
  safe: Address,
): Promise<SafeOnChainState> {
  const [chainId, blockNumber] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  const code = await client.getCode({ address: safe, blockNumber });
  if (code === undefined || code === '0x') {
    return {
      blockNumber,
      chainId,
      hasCode: false,
      version: '',
      owners: [],
      threshold: 0,
      nonce: 0n,
      guard: zeroAddress,
      modules: [],
    };
  }

  const [version, owners, threshold, nonce, guardSlot, modulePage] = await Promise.all([
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'VERSION', blockNumber }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners', blockNumber }),
    client.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
      blockNumber,
    }),
    client.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce', blockNumber }),
    client.getStorageAt({ address: safe, slot: SAFE_GUARD_STORAGE_SLOT, blockNumber }),
    client.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getModulesPaginated',
      args: [SENTINEL_MODULES, 10n],
      blockNumber,
    }),
  ]);

  const guard =
    guardSlot === undefined || /^0x0*$/.test(guardSlot)
      ? zeroAddress
      : decodeAbiParameters([{ type: 'address' }], `0x${guardSlot.slice(2).padStart(64, '0')}`)[0];

  return {
    blockNumber,
    chainId,
    hasCode: true,
    version,
    owners: [...owners],
    threshold: Number(threshold),
    nonce,
    guard,
    modules: [...modulePage[0]],
  };
}
