import { readFileSync } from 'node:fs';

import { createBackends } from './backends/index.js';
import { lookupKey, parseSignerConfig, type SignerConfig } from './config.js';
import { createSignerServer, type Keyring, type KeyringEntry } from './server.js';

type Env = Record<string, string | undefined>;

function readConfig(path: string): SignerConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(
      `SIGNER_CONFIG ${path} is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  return parseSignerConfig(raw);
}

/**
 * Proves every configured address against the key its backend holds, so a
 * wrong keyRef fails here rather than as a signature the engine refuses.
 */
async function verifiedKeyring(config: SignerConfig, env: Env): Promise<Keyring> {
  const entries = [...config.values()];
  const backends = createBackends(
    entries.map((entry) => entry.backend),
    env,
  );

  const keyring = new Map<string, KeyringEntry>();
  const problems: string[] = [];
  for (const entry of entries) {
    const backend = backends.get(entry.backend);
    if (!backend) throw new Error(`backend ${entry.backend} was not built`);
    try {
      const derived = await backend.address(entry.curve, entry.keyRef);
      if (lookupKey(entry.curve, derived) === lookupKey(entry.curve, entry.address)) {
        keyring.set(lookupKey(entry.curve, entry.address), { entry, backend });
      } else {
        problems.push(`${entry.address}: expected ${entry.address}, derived ${derived}`);
      }
    } catch (cause) {
      problems.push(`${entry.address}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`these addresses don't match their keys:\n  ${problems.join('\n  ')}`);
  }
  return keyring;
}

/**
 * Everything the Signer does before it may listen: read and validate
 * SIGNER_CONFIG, build its backends, and prove every address. Throws,
 * naming what is wrong, instead of returning a server that could sign
 * with the wrong key.
 */
export async function buildSigner(env: Env, audit?: (line: string) => void) {
  const configPath = env.SIGNER_CONFIG;
  if (configPath === undefined || configPath === '') {
    throw new Error(
      'SIGNER_CONFIG is required: the path to the JSON file mapping addresses to keys',
    );
  }
  const keyring = await verifiedKeyring(readConfig(configPath), env);
  return createSignerServer({
    keyring,
    authToken: env.SIGNER_AUTH_TOKEN ?? '',
    ...(audit ? { audit } : {}),
  });
}
