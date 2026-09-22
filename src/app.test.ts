import { describe, expect, it } from 'vitest';

import { buildApp } from './app.js';
import { ChainRegistry } from './chain-registry/chain-registry.js';
import { InMemoryDispatchStore } from './repository/in-memory-dispatch-store.js';

async function testApp() {
  return buildApp({
    store: new InMemoryDispatchStore(),
    chainRegistry: await ChainRegistry.load([], {}),
    authToken: 'test-token',
    defaultRetryPolicy: false,
  });
}

describe('GET /health', () => {
  it('returns ok, without requiring auth', async () => {
    const app = await testApp();

    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
