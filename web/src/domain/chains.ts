import type { ChainRef } from './dispatch';

export const CHAINS = {
  solana: { label: 'Solana', mark: 'var(--chain-solana)' },
  base: { label: 'Base', mark: 'var(--chain-base)' },
} as const;

export type Chain = keyof typeof CHAINS;

/** The network the engine talks to for a chain, as `GET /v1/senders` reports it. */
export type Network =
  'base' | 'base-sepolia' | { chainId: number } | 'mainnet-beta' | 'devnet' | 'testnet' | 'unknown';

interface NetworkLinks {
  explorer: string;
  tx: (hash: string) => string;
  /** Where an Approver decides on a Proposal. Absent where the app has no such network. */
  proposal?: (ref: ChainRef) => string | null;
}

const squads = (ref: ChainRef) =>
  ref.kind === 'squads' ? `https://app.squads.so/squads/${ref.multisig}/transactions` : null;
const safe = (prefix: string) => (ref: ChainRef) =>
  ref.kind === 'safe'
    ? `https://app.safe.global/transactions/queue?safe=${prefix}:${ref.safe}`
    : null;

const LINKS: Partial<Record<string, NetworkLinks>> = {
  'mainnet-beta': {
    explorer: 'Solscan',
    tx: (hash) => `https://solscan.io/tx/${hash}`,
    proposal: squads,
  },
  // The Squads app has no devnet or testnet view.
  devnet: { explorer: 'Solscan', tx: (hash) => `https://solscan.io/tx/${hash}?cluster=devnet` },
  testnet: { explorer: 'Solscan', tx: (hash) => `https://solscan.io/tx/${hash}?cluster=testnet` },
  base: {
    explorer: 'Basescan',
    tx: (hash) => `https://basescan.org/tx/${hash}`,
    proposal: safe('base'),
  },
  'base-sepolia': {
    explorer: 'Basescan',
    tx: (hash) => `https://sepolia.basescan.org/tx/${hash}`,
    proposal: safe('basesep'),
  },
};

function linksFor(network: Network): NetworkLinks | undefined {
  return typeof network === 'string' ? LINKS[network] : undefined;
}

/** A transaction on the network's explorer, or null where no explorer is known for it. */
export function txLink(network: Network, hash: string): { label: string; href: string } | null {
  const links = linksFor(network);
  return links ? { label: `View on ${links.explorer}`, href: links.tx(hash) } : null;
}

export function proposalApp(ref: ChainRef): 'Squads' | 'Safe' {
  return ref.kind === 'squads' ? 'Squads' : 'Safe';
}

/** The Proposal in Squads or the Safe's queue, or null where the app does not serve the network. */
export function proposalUrl(network: Network, ref: ChainRef): string | null {
  return linksFor(network)?.proposal?.(ref) ?? null;
}
