export const CHAINS = {
  solana: {
    label: 'Solana',
    explorer: 'Solscan',
    txUrl: (hash: string) => `https://solscan.io/tx/${hash}`,
    mark: 'var(--chain-solana)',
  },
  base: {
    label: 'Base',
    explorer: 'Basescan',
    txUrl: (hash: string) => `https://basescan.org/tx/${hash}`,
    mark: 'var(--chain-base)',
  },
} as const;

export type Chain = keyof typeof CHAINS;
