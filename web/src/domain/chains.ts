import type { ChainRef } from './dispatch';

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

export function proposalApp(ref: ChainRef): 'Squads' | 'Safe' {
  return ref.kind === 'squads' ? 'Squads' : 'Safe';
}

/** Where an Approver decides on the Proposal: the multisig's transactions in Squads, the Safe's queue. */
export function proposalUrl(ref: ChainRef): string {
  return ref.kind === 'squads'
    ? `https://app.squads.so/squads/${ref.multisig}/transactions`
    : `https://app.safe.global/transactions/queue?safe=base:${ref.safe}`;
}
