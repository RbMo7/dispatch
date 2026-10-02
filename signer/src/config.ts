import { isBackendName, type BackendName } from './backends/index.js';
import { CURVES, type Curve } from './backends/key-backend.js';
import { parsePolicy, type Policy } from './policy.js';

/** One address the Signer signs for, and where its key lives. */
export type AddressEntry = {
  /** As written in the config. */
  address: string;
  curve: Curve;
  backend: BackendName;
  keyRef: string;
  /** Absent, the Signer signs anything for this address (still only for an authenticated caller). */
  policy?: Policy;
};

/** Entries keyed by `lookupKey`. */
export type SignerConfig = ReadonlyMap<string, AddressEntry>;

/** EVM addresses compare case-insensitively (the case is only a checksum); Solana's base58 is case-sensitive. */
export function lookupKey(curve: Curve, address: string): string {
  return curve === 'secp256k1' ? address.toLowerCase() : address;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCurve(value: unknown): value is Curve {
  return CURVES.includes(value as Curve);
}

function parseEntry(address: string, value: unknown): AddressEntry | string[] {
  if (!isRecord(value)) return ['must be an object { curve, backend, keyRef, policy? }'];
  const { curve, backend, keyRef, policy } = value;
  if (!isCurve(curve))
    return [`curve must be one of ${CURVES.join(', ')}, got ${JSON.stringify(curve)}`];
  if (!isBackendName(backend)) return [`unknown backend ${JSON.stringify(backend)}`];
  if (typeof keyRef !== 'string' || keyRef === '') return ['keyRef must be a non-empty string'];
  if (policy === undefined) return { address, curve, backend, keyRef };
  const parsed = parsePolicy(curve, policy);
  return Array.isArray(parsed) ? parsed : { address, curve, backend, keyRef, policy: parsed };
}

/**
 * Parses SIGNER_CONFIG's JSON: `{ "<address>": { curve, backend, keyRef, policy? } }`.
 * Throws one error naming every bad address, so a broken config is fixed
 * in one pass rather than one restart per mistake.
 */
export function parseSignerConfig(raw: unknown): SignerConfig {
  if (!isRecord(raw)) throw new Error('SIGNER_CONFIG must be a JSON object keyed by address');

  const entries = new Map<string, AddressEntry>();
  const problems: string[] = [];
  for (const [address, value] of Object.entries(raw)) {
    const entry = parseEntry(address, value);
    if (Array.isArray(entry)) {
      problems.push(...entry.map((problem) => `${address}: ${problem}`));
      continue;
    }
    const key = lookupKey(entry.curve, address);
    const existing = entries.get(key);
    if (existing) {
      problems.push(`${address}: the same address as ${existing.address}`);
      continue;
    }
    entries.set(key, entry);
  }

  if (problems.length > 0) {
    throw new Error(`SIGNER_CONFIG is invalid:\n  ${problems.join('\n  ')}`);
  }
  if (entries.size === 0) throw new Error('SIGNER_CONFIG maps no addresses');
  return entries;
}
