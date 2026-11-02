import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';

import { webStatic } from './web-static.js';

const root = mkdtempSync(path.join(tmpdir(), 'web-engine-'));
for (const [file, body] of [
  ['console/index.html', '<title>console</title>'],
  ['docs/index.html', '<title>docs</title>'],
  ['assets/console-abc123.js', 'console.log(1)'],
]) {
  mkdirSync(path.dirname(path.join(root, file!)), { recursive: true });
  writeFileSync(path.join(root, file!), body!);
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function appWith(webRoot: string) {
  const app = Fastify();
  app.get('/health', () => ({ status: 'ok' }));
  await app.register(webStatic, { root: webRoot });
  return app;
}

describe('webStatic, with an engine build on disk', () => {
  it('redirects / to the console', async () => {
    const app = await appWith(root);
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/console');
  });

  it.each(['/console', '/console/', '/console/_primitives', '/console/dispatches/7f3a'])(
    'serves the console page at %s',
    async (url) => {
      const app = await appWith(root);
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.body).toBe('<title>console</title>');
    },
  );

  it.each(['/docs', '/docs/anything', '/docs/api/dispatch'])(
    'serves the docs page at %s',
    async (url) => {
      const app = await appWith(root);
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('<title>docs</title>');
    },
  );

  it('serves built assets as themselves', async () => {
    const app = await appWith(root);
    const response = await app.inject({ method: 'GET', url: '/assets/console-abc123.js' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('console.log(1)');
  });

  it('leaves paths outside the build to the API', async () => {
    const app = await appWith(root);
    expect((await app.inject({ method: 'GET', url: '/v1/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});

describe('webStatic, with no engine build', () => {
  it.each(['/', '/console', '/console/_primitives', '/docs/anything'])(
    'registers nothing, so %s is a plain 404',
    async (url) => {
      const app = await appWith(path.join(root, 'missing'));
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode).toBe(404);
    },
  );

  it('keeps the API routes', async () => {
    const app = await appWith(path.join(root, 'missing'));
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });
});
