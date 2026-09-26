import { describe, expect, it, vi } from 'vitest';

import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { ChainRegistry, parseEnabledChains } from './chain-registry.js';

describe('parseEnabledChains', () => {
  it('parses a comma-separated list, trimming whitespace', () => {
    expect(parseEnabledChains('solana, base')).toEqual(['solana', 'base']);
  });

  it('returns an empty list for an empty string', () => {
    expect(parseEnabledChains('')).toEqual([]);
  });

  it('ignores empty entries from stray commas', () => {
    expect(parseEnabledChains('solana,,base,')).toEqual(['solana', 'base']);
  });

  it('throws for an unknown chain name', () => {
    expect(() => parseEnabledChains('stellar')).toThrow(/unknown chain/);
  });
});

describe('ChainRegistry', () => {
  it('loads a handler only for each enabled chain, never calling a disabled chain’s loader', async () => {
    const solanaLoader = vi.fn(() => Promise.resolve(new StubChainHandler()));
    const baseLoader = vi.fn(() => Promise.resolve(new StubChainHandler()));

    const registry = await ChainRegistry.load(['solana'], {
      solana: solanaLoader,
      base: baseLoader,
    });

    expect(solanaLoader).toHaveBeenCalledTimes(1);
    expect(baseLoader).not.toHaveBeenCalled();
    expect(registry.isEnabled('solana')).toBe(true);
    expect(registry.isEnabled('base')).toBe(false);
  });

  it('get() returns the registered handler for an enabled chain', async () => {
    const handler = new StubChainHandler();
    const registry = await ChainRegistry.load(['solana'], {
      solana: () => Promise.resolve(handler),
    });

    const result = registry.get('solana');

    expect(result).toEqual({ ok: true, value: handler });
  });

  it('get() returns a structured CHAIN_NOT_ENABLED error for a chain that was never enabled', async () => {
    const registry = await ChainRegistry.load([], {});

    const result = registry.get('solana');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({
      code: 'CHAIN_NOT_ENABLED',
      message: 'chain not enabled: solana',
    });
  });

  it('throws when ENABLED_CHAINS names a chain this build has no loader for', async () => {
    await expect(ChainRegistry.load(['solana'], {})).rejects.toThrow(/no Chain Handler loader/);
  });
});
