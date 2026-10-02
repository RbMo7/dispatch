/** Mirrors src/domain/curve.ts on the engine side — kept separate since this package must stay outside the engine's dependency tree (ADR-0002). */
export type Curve = 'secp256k1' | 'ed25519';

export const CURVES: readonly Curve[] = ['secp256k1', 'ed25519'];

/**
 * Where a key lives: a file for development, a remote key store in
 * production. `keyRef` names the key within the backend.
 */
export interface KeyBackend {
  /** The chain address the key signs for: a checksummed EVM address, or a base58 Solana public key. */
  address(curve: Curve, keyRef: string): Promise<string>;
  /**
   * Signs what the curve signs: the 32-byte keccak256 digest on secp256k1,
   * returned as 65 bytes `r || s || recovery` with a low `s`; the message
   * bytes on ed25519, returned as the 64-byte signature.
   */
  sign(curve: Curve, keyRef: string, payload: Uint8Array): Promise<Uint8Array>;
}
