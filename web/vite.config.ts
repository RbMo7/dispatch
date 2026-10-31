import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

import { THEME_BOOT_SCRIPT } from './src/theme.ts';

// One codebase, two builds, chosen by --mode. Each page is its own HTML entry
// with an SPA under its prefix; `home` is where the engine build sends `/`.
const BUILDS = {
  engine: { pages: { console: 'console/index.html', docs: 'docs/index.html' }, home: '/console' },
  public: { pages: { landing: 'index.html', docs: 'docs/index.html' }, home: null },
} as const;

type Build = (typeof BUILDS)[keyof typeof BUILDS];

function isBuildMode(mode: string): mode is keyof typeof BUILDS {
  return mode in BUILDS;
}

// The dev server's version of what src/web-static.ts does in the engine:
// /console/anything and /docs/anything get their page's index.html.
function spaFallback(build: Build): Plugin {
  const prefixes = Object.keys(build.pages).filter((page) => page !== 'landing');
  return {
    name: 'dispatch-spa-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '/').split('?')[0]!;
        if (path === '/' && build.home) {
          res.writeHead(302, { Location: build.home }).end();
          return;
        }
        const prefix = prefixes.find((p) => path === `/${p}` || path.startsWith(`/${p}/`));
        if (prefix && !/\.\w+$/.test(path)) req.url = `/${prefix}/index.html`;
        next();
      });
    },
  };
}

const themeBoot: Plugin = {
  name: 'dispatch-theme-boot',
  transformIndexHtml: () => [{ tag: 'script', children: THEME_BOOT_SCRIPT, injectTo: 'head' }],
};

export default defineConfig(({ mode }) => {
  if (!isBuildMode(mode)) {
    throw new Error(`unknown mode "${mode}": use --mode engine or --mode public`);
  }
  const build = BUILDS[mode];
  const resolve = (file: string) => fileURLToPath(new URL(file, import.meta.url));

  return {
    appType: 'mpa',
    plugins: [react(), spaFallback(build), themeBoot],
    build: {
      outDir: `dist/${mode}`,
      emptyOutDir: true,
      rolldownOptions: {
        input: Object.fromEntries(
          Object.entries(build.pages).map(([name, file]) => [name, resolve(file)]),
        ),
      },
    },
  };
});
