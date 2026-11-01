import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';

// Resolved from this file, so it is the same directory whether the API runs
// from src/ (tsx) or dist/ (node).
const ENGINE_WEB_ROOT = fileURLToPath(new URL('../web/dist/engine/', import.meta.url));

const PAGES = ['console', 'docs'];

/**
 * Serves the web engine build (`pnpm --dir web build`) from the API process:
 * `/console/*` and `/docs/*`, with `/` redirecting to the console. Without a
 * build on disk it registers nothing, and the API is exactly the API.
 */
export const webStatic: FastifyPluginAsync<{ root?: string }> = async (
  app,
  { root = ENGINE_WEB_ROOT },
) => {
  if (!existsSync(root)) return;

  // Serving only Vite's assets/ prefix keeps the API's other paths untouched,
  // and a rebuild needs no restart.
  await app.register(fastifyStatic, {
    root: path.join(root, 'assets'),
    prefix: '/assets/',
    index: false,
  });

  app.get('/', (_request, reply) => reply.redirect('/console'));
  for (const page of PAGES) {
    const serve = (_request: unknown, reply: FastifyReply) =>
      reply.sendFile(`${page}/index.html`, root);
    app.get(`/${page}`, serve);
    app.get(`/${page}/*`, serve);
  }
};
