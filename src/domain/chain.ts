/**
 * A chain family (ADR-0017) — never a family-and-tier identifier. Which
 * network a Chain Handler talks to is deployment config, not a distinct type.
 * `base` and Ethereum L1 are separate Chains despite sharing a virtual
 * machine and wire format (ADR-0035) — there is no `evm` family value here.
 */
export type Chain = 'base' | 'solana';
