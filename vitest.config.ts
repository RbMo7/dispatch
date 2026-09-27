import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { configDefaults, defineConfig } from 'vitest/config';

// Operator/test secrets (e.g. SOLANA_DEVNET_RPC_URL, BASE_TRACE_RPC_URL) live
// in a gitignored .env; without loading it every live test silently falls
// back to the public, rate-limited RPCs. Real env vars still win.
if (existsSync('.env')) process.loadEnvFile('.env');

/**
 * Live tests — real devnet / Base Sepolia (ADR-0013), spending testnet funds
 * — are exactly the ones that use a chain's test-support fixtures.
 * `TEST_TIER=offline` (CI) runs everything else: unit tests, the fake-store
 * Coordinator tests, and the real-Postgres tier (ADR-0034). Derived from
 * the imports, so a new live test can't slip into CI by accident.
 */
function liveTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return liveTestFiles(file);
    if (!entry.name.endsWith('.test.ts')) return [];
    return /test-support\/(base|devnet)-fixtures/.test(readFileSync(file, 'utf8')) ? [file] : [];
  });
}

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude:
      process.env.TEST_TIER === 'offline'
        ? [...configDefaults.exclude, ...liveTestFiles('src')]
        : configDefaults.exclude,
  },
});
