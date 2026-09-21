/**
 * A chain family (ADR-0017) — never a family-and-tier identifier. Which
 * network a Chain Handler talks to is deployment config, not a distinct type.
 */
export type Chain = 'evm' | 'solana';
