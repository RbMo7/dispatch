import { fileURLToPath } from 'node:url';

import { defineConfig, type Plugin } from 'vitest/config';

import { docsPlugin } from './scripts/docs.ts';

export default defineConfig({
  // Vitest 3 runs on its own Vite 7, whose Plugin type differs from Vite 8's
  // only in hooks the docs plugin does not use.
  plugins: [docsPlugin(fileURLToPath(new URL('..', import.meta.url))) as unknown as Plugin],
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.tsx', 'src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
