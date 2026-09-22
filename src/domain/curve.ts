/**
 * The signing curve a Signer's `/sign` contract requires (ADR-0002):
 * `secp256k1` for EVM-shaped chains, `ed25519` for Solana-shaped ones.
 */
export type Curve = 'secp256k1' | 'ed25519';
