import type { KeyBackend } from './key-backend.js';
import { createKeyfileBackend } from './keyfile.js';

type Env = Record<string, string | undefined>;

function requireEnv(env: Env, name: string, neededBy: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required by ${neededBy}`);
  return value;
}

/** Each backend an address can name in SIGNER_CONFIG, built from the environment. */
const BACKENDS = {
  keyfile: (env: Env) =>
    createKeyfileBackend(requireEnv(env, 'SIGNER_KEYFILE', 'the keyfile backend')),
} satisfies Record<string, (env: Env) => KeyBackend>;

export type BackendName = keyof typeof BACKENDS;

export function isBackendName(value: unknown): value is BackendName {
  return typeof value === 'string' && Object.hasOwn(BACKENDS, value);
}

/** Builds only the named backends, so an unused one never asks for its credentials. */
export function createBackends(
  names: Iterable<BackendName>,
  env: Env,
): ReadonlyMap<BackendName, KeyBackend> {
  return new Map([...new Set(names)].map((name) => [name, BACKENDS[name](env)]));
}
