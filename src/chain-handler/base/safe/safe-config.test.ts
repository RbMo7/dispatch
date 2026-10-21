import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_APPROVAL_DEADLINE_MS,
  DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
  resolveBaseSafeConfig,
  type RawBaseSafeSettings,
} from './safe-config.js';

const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const EXECUTOR = '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E';

const single: RawBaseSafeSettings = {
  senderMode: '',
  senderAddress: '',
  safeAddress: '',
  safeExecutorAddress: '',
  txServiceUrl: '',
  apiKey: '',
  approvalDeadlineMs: '',
  approvalRewatchWindowMs: '',
};
const safe: RawBaseSafeSettings = {
  ...single,
  senderMode: 'safe',
  safeAddress: SAFE,
  safeExecutorAddress: EXECUTOR,
};

describe('resolveBaseSafeConfig', () => {
  it('single mode (the default) is a no-op, whether the mode is unset or explicit', () => {
    expect(resolveBaseSafeConfig(single, 84532)).toBeUndefined();
    expect(resolveBaseSafeConfig({ ...single, senderMode: 'single' }, 8453)).toBeUndefined();
  });

  it('refuses Safe settings left in single mode rather than silently ignoring them', () => {
    expect(() => resolveBaseSafeConfig({ ...single, safeAddress: SAFE }, 84532)).toThrow(
      /BASE_SAFE_ADDRESS set while BASE_SENDER_MODE is "single"/,
    );
  });

  it('refuses an unknown mode', () => {
    expect(() => resolveBaseSafeConfig({ ...single, senderMode: 'multisig' }, 84532)).toThrow(
      /BASE_SENDER_MODE must be "single" or "safe"/,
    );
  });

  it('applies the documented defaults per chain ID', () => {
    const sepolia = resolveBaseSafeConfig(safe, 84532);
    expect(sepolia).toEqual({
      safeAddress: SAFE,
      executorAddress: EXECUTOR,
      txServiceUrl: 'https://api.safe.global/tx-service/basesep',
      apiKey: undefined,
      approvalDeadlineMs: 259_200_000,
      approvalRewatchWindowMs: 2_592_000_000,
    });
    expect(DEFAULT_APPROVAL_DEADLINE_MS).toBe(72 * 3600 * 1000);
    expect(DEFAULT_APPROVAL_REWATCH_WINDOW_MS).toBe(30 * 24 * 3600 * 1000);
    expect(resolveBaseSafeConfig(safe, 8453)?.txServiceUrl).toBe(
      'https://api.safe.global/tx-service/base',
    );
  });

  it('takes explicit values, trims a trailing slash and normalizes a lowercase address', () => {
    const resolved = resolveBaseSafeConfig(
      {
        ...safe,
        safeAddress: SAFE.toLowerCase(),
        txServiceUrl: 'https://safe.internal/tx/',
        apiKey: ' secret ',
        approvalDeadlineMs: '1000',
        approvalRewatchWindowMs: '2000',
      },
      84532,
    );
    expect(resolved).toMatchObject({
      safeAddress: SAFE,
      txServiceUrl: 'https://safe.internal/tx',
      apiKey: 'secret',
      approvalDeadlineMs: 1000,
      approvalRewatchWindowMs: 2000,
    });
  });

  it('requires a service URL on a chain with no hosted default', () => {
    expect(() => resolveBaseSafeConfig(safe, 1234)).toThrow(/BASE_SAFE_TX_SERVICE_URL is required/);
  });

  it('accepts BASE_SENDER_ADDRESS only when it equals the executor', () => {
    expect(resolveBaseSafeConfig({ ...safe, senderAddress: EXECUTOR }, 84532)).toBeDefined();
    expect(() =>
      resolveBaseSafeConfig(
        { ...safe, senderAddress: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A' },
        84532,
      ),
    ).toThrow(/BASE_SENDER_ADDRESS .* must equal BASE_SAFE_EXECUTOR_ADDRESS/);
  });

  it('names every bad or missing address at once', () => {
    let message = '';
    try {
      resolveBaseSafeConfig({ ...safe, safeAddress: 'nope', safeExecutorAddress: '' }, 84532);
    } catch (cause) {
      message = (cause as Error).message;
    }
    expect(message).toMatch(/BASE_SAFE_ADDRESS is not a valid address/);
    expect(message).toMatch(/BASE_SAFE_EXECUTOR_ADDRESS is required/);
  });

  it('rejects a mixed-case address with a bad checksum', () => {
    const bad = EXECUTOR.replace('2d0b', '2D0B');
    expect(() => resolveBaseSafeConfig({ ...safe, safeExecutorAddress: bad }, 84532)).toThrow(
      /BASE_SAFE_EXECUTOR_ADDRESS is not a valid address/,
    );
  });

  it('refuses the Safe as its own executor', () => {
    expect(() => resolveBaseSafeConfig({ ...safe, safeExecutorAddress: SAFE }, 84532)).toThrow(
      /must be different addresses/,
    );
  });

  it('refuses non-positive or fractional durations and a non-http URL', () => {
    expect(() => resolveBaseSafeConfig({ ...safe, approvalDeadlineMs: '0' }, 84532)).toThrow(
      /BASE_APPROVAL_DEADLINE_MS must be a positive whole number/,
    );
    expect(() => resolveBaseSafeConfig({ ...safe, approvalRewatchWindowMs: '1.5' }, 84532)).toThrow(
      /BASE_APPROVAL_REWATCH_WINDOW_MS/,
    );
    expect(() => resolveBaseSafeConfig({ ...safe, txServiceUrl: 'ftp://x' }, 84532)).toThrow(
      /not a valid http\(s\) URL/,
    );
  });
});

describe('config.base.senderAddress', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load(env: Record<string, string>) {
    vi.resetModules();
    for (const name of ['BASE_SENDER_MODE', 'BASE_SENDER_ADDRESS', 'BASE_SAFE_EXECUTOR_ADDRESS']) {
      vi.stubEnv(name, env[name] ?? '');
    }
    return (await import('../../../config.js')).config.base;
  }

  it('is BASE_SENDER_ADDRESS in single mode, untouched by Safe settings', async () => {
    const base = await load({ BASE_SENDER_ADDRESS: '0xabc', BASE_SAFE_EXECUTOR_ADDRESS: EXECUTOR });
    expect(base.senderAddress).toBe('0xabc');
  });

  it('falls back to the executor in safe mode', async () => {
    const base = await load({ BASE_SENDER_MODE: 'safe', BASE_SAFE_EXECUTOR_ADDRESS: EXECUTOR });
    expect(base.senderAddress).toBe(EXECUTOR);
  });
});
