import { existsSync } from 'node:fs';

import { defineConfig } from 'vitest/config';

// Operator/test secrets (e.g. SOLANA_DEVNET_RPC_URL, BASE_TRACE_RPC_URL) live
// in a gitignored .env; without loading it every live test silently falls
// back to the public, rate-limited RPCs. Real env vars still win.
if (existsSync('.env')) process.loadEnvFile('.env');

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
