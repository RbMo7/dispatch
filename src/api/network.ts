/** Which network the engine talks to for a chain, so a reader can link to the right explorer. */
export type Network =
  'base' | 'base-sepolia' | { chainId: number } | 'mainnet-beta' | 'devnet' | 'testnet' | 'unknown';

export function baseNetwork(chainId: number): Network {
  if (chainId === 8453) return 'base';
  if (chainId === 84532) return 'base-sepolia';
  return { chainId };
}

const SOLANA_GENESIS_HASHES: Partial<Record<string, Network>> = {
  '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d': 'mainnet-beta',
  EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG: 'devnet',
  '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY': 'testnet',
};

export function solanaNetwork(genesisHash: string | undefined): Network {
  return (genesisHash === undefined ? undefined : SOLANA_GENESIS_HASHES[genesisHash]) ?? 'unknown';
}
