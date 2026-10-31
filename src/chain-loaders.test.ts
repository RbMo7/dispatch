import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChainRegistry } from './chain-registry/chain-registry.js';
import { StubChainHandler } from './chain-handler/stub-chain-handler.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

async function senderConfigsWith(env: Record<string, string>) {
  Object.assign(process.env, env);
  vi.resetModules();
  const { senderConfigsFor } = await import('./chain-loaders.js');
  const registry = await ChainRegistry.load(['base'], {
    base: () => Promise.resolve(new StubChainHandler()),
  });
  return () => senderConfigsFor(registry, () => undefined);
}

describe('senderConfigsFor', () => {
  it('refuses to start when an enabled chain has no Sender address', async () => {
    const configs = await senderConfigsWith({ BASE_SENDER_ADDRESS: '', BASE_SENDER_MODE: '' });

    expect(configs).toThrow(/"base" is enabled but has no Sender address/);
  });

  it("reports an enabled chain's configured Sender", async () => {
    const configs = await senderConfigsWith({
      BASE_SENDER_ADDRESS: '0x1111111111111111111111111111111111111111',
      BASE_SENDER_MODE: '',
    });

    expect(configs()).toMatchObject([
      { chain: 'base', address: '0x1111111111111111111111111111111111111111' },
    ]);
  });
});
